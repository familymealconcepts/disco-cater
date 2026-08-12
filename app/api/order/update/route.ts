import { NextRequest, NextResponse } from 'next/server'
import { sanitizePhoneFields } from '../../../../lib/utils/phone'
import { fmFetch } from '../../../../lib/fm-fetch'
import { isDiscoNativeRestaurant, priceNativeFmDto } from '../../../../lib/order/native-checkout'
import { previewRestaurantFundedDiscount } from '../../../../lib/promo-apply'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Forwards the order re-price to FM. FM's order-update PUT returns
// UNKNOWN_SERVER_ERROR when it receives any non-standard field, so instead of
// blacklisting known-bad fields we WHITELIST only the standard checkout-DTO
// fields and drop everything else. Notably this strips taxExempt / taxExemptId /
// taxExemptState (tax exemption is a customer-account concern in FM, not
// per-order — reflected client-side in the UI) and any other extras the client
// may add (headcount, paymentMethod, sourceoforder, restaurantPromoCode,
// serviceChargePct, userEmail, …) — the last three are Disco-only signals for
// applyRestaurantFundedPreview below, never sent to FM (FM has never heard of
// Disco's promo_codes table — see lib/promo-apply.ts's own header comment on
// why forwarding a Disco code into FM isn't the fix here).
const FM_UPDATE_ALLOWED_FIELDS = [
  'restaurantReference', 'items', 'mealPackages', 'orderType', 'orderDate', 'orderTime',
  'tips', 'tipsType', 'couponCode', 'deliveryAddress', 'persons', 'subtotal', 'total', 'fee',
] as const

// Patch FM's raw response with the restaurant-funded discount BEFORE returning
// it to the client — this is what makes the preview agree with what
// applyRestaurantFundedDiscount ultimately charges at placement (lib/promo-
// apply.ts's computeRestaurantFundedBreakdown is the SAME function both call).
// Falls back to FM's own undiscounted numbers, untouched, on any self-check
// failure or resolution failure — never shows a guess.
async function applyPreviewDiscount(data: unknown, body: Record<string, unknown>): Promise<void> {
  const restaurantPromoCode = typeof body.restaurantPromoCode === 'string' ? body.restaurantPromoCode.trim() : ''
  if (!restaurantPromoCode) return
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const container = data as Record<string, unknown>
  const inner = (container.data ?? container) as Record<string, unknown>
  const dto = (inner.checkoutPublicResponseDto ?? inner) as Record<string, unknown>
  if (!dto || typeof dto !== 'object') return

  const restaurantRef = String(body.restaurantRef || body.restaurantReference || '')
  const serviceChargePct = Number(body.serviceChargePct) || 0
  const orderType = String(body.orderType || 'PICKUP')
  const userEmail = String(body.userEmail || '')

  const result = await previewRestaurantFundedDiscount({
    restaurantRef, code: restaurantPromoCode, serviceChargePct, orderType, fmCheckout: dto, userEmail,
  }).catch((e) => {
    console.error('[order/update] preview discount computation threw:', e instanceof Error ? e.message : e)
    return { applied: false as const, reason: 'threw' }
  })
  if (!result.applied) return

  const b = result.breakdown
  dto.stateSalesTaxInPrice = b.stateTax
  dto.localSalesTaxInPrice = b.localTax
  dto.otherSalesTaxInPrice = b.otherTax
  dto.fee = b.familyMealFee
  dto.serviceCharge = b.serviceCharge
  dto.tipsInPrice = Math.round((b.tipsInPrice + b.thirdPartyDeliveryTips) * 100) / 100
  dto.discount = b.discount
  dto.total = b.total
  // subtotal and deliveryFee are deliberately left as FM's own reported values —
  // subtotal is always shown at its raw (undiscounted) figure with a separate
  // Discount line, same convention as native; delivery fee for FM-backed
  // restaurants is FM's own fixed figure, not a subtotal-scaled one, so the
  // discount never touches it (matches computeBreakdown's own treatment, which
  // never recomputes ownDeliveryFee/thirdPartyDeliveryFee from discountPct).
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { restaurantRef, orderRef } = body
    if (!restaurantRef || !orderRef) {
      return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
    }

    // ── Disco-native path: re-price the FM-shaped DTO in Neon (zero FM). ──
    if (await isDiscoNativeRestaurant(restaurantRef)) {
      return NextResponse.json(await priceNativeFmDto(body))
    }

    // Whitelist: keep only FM's standard checkout-DTO fields; drop everything else.
    const updateBody: Record<string, unknown> = {}
    for (const k of FM_UPDATE_ALLOWED_FIELDS) {
      if (body[k] !== undefined) updateBody[k] = body[k]
    }

    // FM requires orderType as "PICKUP" or "DELIVERY" — empty string causes 500.
    // Normalize as a server-side backstop so a missing/blank value can never 500.
    updateBody.orderType = updateBody.orderType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'

    // FM rejects formatted phone numbers — digits only. Sanitize any phone field
    // (e.g. deliveryAddress.phoneNumber) anywhere in the update body before FM.
    sanitizePhoneFields(updateBody)

    const url = `${FM}/public-api/v2/restaurants/${restaurantRef}/orders/${orderRef}`
    const res = await fmFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(updateBody),
    })
    // Read the body as text first so a non-JSON FM error (HTML/plain 500) can't
    // throw on res.json() and mask the real cause as a generic proxy 500.
    const text = await res.text()
    if (!res.ok) console.error('[order/update] FM error', res.status, text.slice(0, 300))
    let data: unknown
    try { data = text ? JSON.parse(text) : {} } catch {
      data = { error: 'FM returned a non-JSON response', fmStatus: res.status, fmBody: text.slice(0, 1000) }
    }
    if (res.ok) await applyPreviewDiscount(data, body)
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }
}
