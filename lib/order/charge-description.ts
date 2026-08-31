// The Stripe charge description a RESTAURANT reads when reconciling what they were
// paid for.
//
// WHY THIS EXISTS. Disco's native charges carried only "Disco Cater order #900000104"
// — no breakdown at all. FM's equivalent string does carry one, and it does not
// reconcile: on pi_3UAa7Q… (We Begg To Differ, 2026-08-31) it accounted for $185.40
// of a $262.98 charge, omitting the $27.00 delivery fee, the $36.00 courier tip and
// $14.58 of sales tax; reported "Tips: 0" against $36 actually collected; labelled a
// DLIVRD delivery as "Pickup date"; and printed each line's TOTAL in the unit-price
// slot while also printing "X{count}", so a 2× line read as double its real value.
// As FM is sunset this string becomes the one restaurants read, so Disco's own must
// add up.
//
// BUILT FROM THE SAME BREAKDOWN THAT COMPUTES THE CHARGE, which is the only reason it
// reconciles by construction rather than by agreement. computeBreakdown defines:
//
//   total = base + stateTax + localTax + otherTax
//         + ownDeliveryFee + thirdPartyDeliveryFee
//         + familyMealFee + serviceCharge + tipsInPrice + thirdPartyDeliveryTips
//
// with base = subtotal − discount. Every one of those terms is printed, so the
// printed lines sum to the charge exactly.
//
// stripeFee and leadGen are DELIBERATELY ABSENT. They are not part of the customer
// total — they come off the restaurant's transfer — so printing them in this sum
// would break the reconciliation this file exists to guarantee. The restaurant's
// payout is a separate figure and belongs in payout reporting, not in the charge
// description.
//
// UNIT PRICE, NOT LINE TOTAL, next to X{count} — the specific error above. A reader
// multiplying what they see must land on the line total.
import { cents } from '../promo-pricing'

export interface ChargeDescriptionItem {
  name: string
  /** UNIT price excluding add-ons. Never the line total. */
  basePrice: number
  quantity: number
  addOns?: { name: string; price: number; quantity: number }[]
}

export interface ChargeDescriptionArgs {
  orderNumber: string | number
  orderDate?: string | null
  /** 'PICKUP' | 'DELIVERY' — printed as the real fulfillment, never assumed. */
  orderType?: string | null
  items?: ChargeDescriptionItem[]
  subtotal: number
  discount: number
  serviceCharge: number
  stateTax: number
  localTax: number
  otherTax: number
  ownDeliveryFee: number
  thirdPartyDeliveryFee: number
  /** Tip to the RESTAURANT. */
  tipsInPrice: number
  /** Tip to the COURIER — a different field, and the one FM reported as 0. */
  thirdPartyDeliveryTips: number
  familyMealFee: number
  total: number
}

// Stripe accepts a long description, but a 40-line cart would produce an unreadable
// wall. Budget the itemization and say plainly how many were omitted rather than
// truncating mid-list and looking complete.
const ITEM_BUDGET_CHARS = 700
const money = (n: number) => n.toFixed(2)

/**
 * Returns the reconciling description, or NULL when the printed components do not
 * sum to the charge.
 *
 * Null rather than a throw, and null rather than an approximate string: a
 * description must never block a charge, and a breakdown that does not add up is
 * worse than no breakdown — it is exactly the failure being fixed. The caller falls
 * back to the plain one-line description and logs.
 */
export function buildNativeChargeDescription(a: ChargeDescriptionArgs): string | null {
  const tax = a.stateTax + a.localTax + a.otherTax
  const delivery = a.ownDeliveryFee + a.thirdPartyDeliveryFee

  // Reconcile in CENTS, against the same cents() the PaymentIntent amount uses, so
  // this can never disagree with the charge by a rounding step.
  const componentCents =
    cents(a.subtotal) - cents(a.discount) + cents(a.serviceCharge) + cents(tax) +
    cents(delivery) + cents(a.tipsInPrice) + cents(a.thirdPartyDeliveryTips) + cents(a.familyMealFee)
  if (componentCents !== cents(a.total)) return null

  const lines: string[] = []
  lines.push(`Disco Cater order #${a.orderNumber}`)
  if (a.orderDate) {
    const kind = String(a.orderType || '').toUpperCase() === 'DELIVERY' ? 'Delivery' : 'Pickup'
    lines.push(`${kind}: ${a.orderDate}`)
  }

  lines.push(`Subtotal ${money(a.subtotal)}`)
  if (a.discount > 0) lines.push(`Promo -${money(a.discount)}`)
  if (a.serviceCharge > 0) lines.push(`Service charge ${money(a.serviceCharge)}`)
  if (tax > 0) lines.push(`Sales tax ${money(tax)}`)
  if (delivery > 0) lines.push(`Delivery fee ${money(delivery)}`)
  if (a.thirdPartyDeliveryTips > 0) lines.push(`Courier tip ${money(a.thirdPartyDeliveryTips)}`)
  if (a.tipsInPrice > 0) lines.push(`Tip ${money(a.tipsInPrice)}`)
  if (a.familyMealFee > 0) lines.push(`Platform fee ${money(a.familyMealFee)}`)
  lines.push(`Total ${money(a.total)} USD`)

  const items = a.items ?? []
  if (items.length) {
    const parts: string[] = []
    let used = 0
    let shown = 0
    for (const it of items) {
      // UNIT price × count. A reader multiplying these lands on the line total.
      let part = `${it.name.trim()} ${money(it.basePrice)} x${Math.max(1, Math.trunc(it.quantity))}`
      for (const ad of it.addOns ?? []) {
        part += ` + ${ad.name.trim()} ${money(ad.price)} x${Math.max(1, Math.trunc(ad.quantity))}`
      }
      if (used + part.length > ITEM_BUDGET_CHARS && shown > 0) break
      parts.push(part)
      used += part.length + 2
      shown++
    }
    const omitted = items.length - shown
    lines.push(`Items: ${parts.join('; ')}${omitted > 0 ? ` (+${omitted} more item${omitted === 1 ? '' : 's'})` : ''}`)
  }

  return lines.join(' | ')
}
