import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { sanitizePhoneFields } from '../../../../lib/utils/phone'
import { fmFetch } from '../../../../lib/fm-fetch'
import { isDiscoNativeRestaurant, priceNativeFmDto, isNativeOrderingOpen } from '../../../../lib/order/native-checkout'
import { previewRestaurantFundedDiscount, dinerMessageForRestaurantPromoReason } from '../../../../lib/promo-apply'
import { recordFunnelStage, isTrackableInitStage } from '../../../../lib/checkout-funnel'
import { assertRestaurantOrderable, orderableErrorBody } from '../../../../lib/restaurant-orderable'

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
    // funnel* fields are the checkout-funnel-capture signal (lib/checkout-funnel.ts)
    // — also Disco-only, also never forwarded.
    const {
      restaurantRef, restaurantPromoCode: _rpc, serviceChargePct: _scp, userEmail: _ue,
      funnelSessionId, funnelStage, funnelCartValueCents, funnelItemCount, funnelFulfillmentType,
      ...orderBody
    } = body
    if (!restaurantRef) return NextResponse.json({ error: 'restaurantRef required' }, { status: 400 })

    // Earliest cheap refusal for an archived / ordering-disabled restaurant.
    // The page-level gate (shared.tsx) used to be the ONLY thing stopping this,
    // which a direct API call or an already-open tab walks straight around.
    // Read-only — see lib/restaurant-orderable.ts.
    const orderable = await assertRestaurantOrderable(restaurantRef)
    if (!orderable.orderable) {
      const { body: errBody, status } = orderableErrorBody(orderable)
      return NextResponse.json(errBody, { status })
    }

    // Fire-and-forget: this route is hit by BOTH RestaurantClient's display-only
    // pricing preview (funnelStage CHECKOUT_READY — earliest signal of a
    // checkout-ready cart, fires before the drawer even opens) and
    // CheckoutDrawer's own real init (funnelStage CHECKOUT_OPENED, the call
    // that actually mints the order draft). Only fires on a real priced
    // response, never on an error/403, and never blocks or affects it —
    // waitUntil schedules the write after the response is already underway.
    function trackInit() {
      if (!isTrackableInitStage(funnelStage) || !funnelSessionId) return
      waitUntil(
        recordFunnelStage({
          sessionId: funnelSessionId,
          restaurantReference: restaurantRef,
          stage: funnelStage,
          fulfillmentType: funnelFulfillmentType === 'PICKUP' || funnelFulfillmentType === 'DELIVERY' ? funnelFulfillmentType : null,
          cartValueCents: Number.isFinite(funnelCartValueCents) ? funnelCartValueCents : null,
          itemCount: Number.isFinite(funnelItemCount) ? funnelItemCount : null,
        }).catch((e) => console.error('[order/init] funnel capture failed (non-fatal):', e instanceof Error ? e.message : e)),
      )
    }

    // ── Disco-native path: price the FM-shaped cart DTO in Neon (zero FM) and
    // return the FM response envelope the client already reads. ──
    if (await isDiscoNativeRestaurant(restaurantRef)) {
      if (!(await isNativeOrderingOpen(restaurantRef))) {
        return NextResponse.json({ error: 'This restaurant is not currently accepting online orders.' }, { status: 403 })
      }
      const priced = await priceNativeFmDto(body)
      trackInit()
      return NextResponse.json(priced)
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
    if (res.ok) {
      await applyPreviewDiscount(data, body)
      trackInit()
    }
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to init order' }, { status: 500 })
  }
}
