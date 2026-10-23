// The GA4 checkout_completed event: what an order was charged, and firing it once per order.
//
// checkout_completed is the Google Ads conversion (imported from GA4 as the account's primary
// Purchase action, 23 Oct 2026), so it carries transaction_id, value and currency, and must
// count each order once. Pure apart from the storage handed in, so scripts/tests/checkout-conversion.test.ts
// runs it under plain node.

type PlaceResponse = Record<string, unknown> | null | undefined

function money(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * The amount the diner is charged, in dollars, read off the /api/order/place response; null when
 * the response does not say. In order:
 *   - Disco-native: `breakdown.total`, the customer charge (dollars -- native-checkout.ts converts
 *     it with cents() when it builds the Stripe charge).
 *   - FM-backed: `restaurantPromoCharge` then `taxExemptCharge`, which the route sets when it
 *     reduces the PaymentIntent (the promo is applied after tax exemption, so it is the final
 *     amount when both apply); otherwise FM's own total, under data.checkoutPublicResponseDto or
 *     data, the same places the route's extractMoney reads.
 */
export function chargedTotalFromPlace(placeData: PlaceResponse): number | null {
  if (!placeData || typeof placeData !== 'object') return null
  const breakdown = placeData.breakdown as Record<string, unknown> | undefined
  if (placeData.native) return money(breakdown?.total)
  const promo = money(placeData.restaurantPromoCharge)
  if (promo != null) return promo
  const exempt = money(placeData.taxExemptCharge)
  if (exempt != null) return exempt
  const inner = placeData.data as Record<string, unknown> | undefined
  const dto = (inner?.checkoutPublicResponseDto as Record<string, unknown> | undefined) ?? inner
  return money(dto?.total ?? dto?.totalAmount ?? dto?.transactionsTotal)
}

export type ConversionValue = { value: number; source: 'charged' | 'estimate' }

/** The charged total when the place response has it, else the checkout's own estimate. Rounded to cents. */
export function conversionValue(placeData: PlaceResponse, estimate: number): ConversionValue {
  const charged = chargedTotalFromPlace(placeData)
  const v = charged ?? estimate
  return { value: Math.round(v * 100) / 100, source: charged != null ? 'charged' : 'estimate' }
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

export const CONVERSION_SENT_PREFIX = 'disco_checkout_completed_'

/**
 * True the first time it is asked about an order in this browser session, false after. GA4 only
 * de-duplicates by transaction_id for its standard `purchase` event, so a custom event needs its
 * own guard. Storage that is unavailable or throws (private mode, quota) answers true: a missing
 * guard can at worst double-count, while a failed guard that answered false would drop a real
 * conversion.
 */
export function firstConversionForOrder(transactionId: string, store: KeyValueStore | null | undefined): boolean {
  if (!transactionId) return true
  try {
    if (!store) return true
    const key = CONVERSION_SENT_PREFIX + transactionId
    if (store.getItem(key)) return false
    store.setItem(key, '1')
    return true
  } catch {
    return true
  }
}
