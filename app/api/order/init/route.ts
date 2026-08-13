import { NextRequest, NextResponse } from 'next/server'
import { sanitizePhoneFields } from '../../../../lib/utils/phone'
import { fmFetch } from '../../../../lib/fm-fetch'
import { isDiscoNativeRestaurant, priceNativeFmDto, isNativeOrderingOpen } from '../../../../lib/order/native-checkout'
import { previewRestaurantFundedDiscount, dinerMessageForRestaurantPromoReason } from '../../../../lib/promo-apply'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Same discount patch as /api/order/update — see that file's applyPreviewDiscount
// for the full reasoning (same self-check function placement uses, restaurantPromoError
// surfaced instead of a silent fallback to FM's undiscounted numbers on any
// failure, subtotal/deliveryFee left untouched). No orderRef exists yet at init
// time, so the log line omits it.
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
    console.error('[order/init] preview discount computation threw:', e instanceof Error ? e.message : e)
    return { applied: false as const, reason: 'threw' }
  })
  if (!result.applied) {
    console.error(`[order/init] restaurant-funded promo not applied: restaurant=${restaurantRef} code=${restaurantPromoCode} reason=${result.reason}`)
    container.restaurantPromoError = dinerMessageForRestaurantPromoReason(result.reason)
    return
  }

  const b = result.breakdown
  dto.stateSalesTaxInPrice = b.stateTax
  dto.localSalesTaxInPrice = b.localTax
  dto.otherSalesTaxInPrice = b.otherTax
  dto.fee = b.familyMealFee
  dto.serviceCharge = b.serviceCharge
  dto.tipsInPrice = Math.round((b.tipsInPrice + b.thirdPartyDeliveryTips) * 100) / 100
  dto.discount = b.discount
  dto.total = b.total
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // restaurantPromoCode/serviceChargePct/userEmail are Disco-only signals for
    // applyPreviewDiscount below — never forwarded to FM (see that function's
    // comment for why forwarding a Disco code into FM isn't the fix here).
    const { restaurantRef, restaurantPromoCode: _rpc, serviceChargePct: _scp, userEmail: _ue, ...orderBody } = body
    if (!restaurantRef) return NextResponse.json({ error: 'restaurantRef required' }, { status: 400 })

    // ── Disco-native path: price the FM-shaped cart DTO in Neon (zero FM) and
    // return the FM response envelope the client already reads. ──
    if (await isDiscoNativeRestaurant(restaurantRef)) {
      if (!(await isNativeOrderingOpen(restaurantRef))) {
        return NextResponse.json({ error: 'This restaurant is not currently accepting online orders.' }, { status: 403 })
      }
      return NextResponse.json(await priceNativeFmDto(body))
    }

    // FM rejects formatted phone numbers — digits only. Sanitize any phone field
    // anywhere in the init body (customer / deliveryAddress) before forwarding.
    sanitizePhoneFields(orderBody)

    const res = await fmFetch(`${FM}/public-api/v2/restaurants/${restaurantRef}/orders/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(orderBody),
    })
    const data = await res.json()
    if (res.ok) await applyPreviewDiscount(data, body)
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to init order' }, { status: 500 })
  }
}
