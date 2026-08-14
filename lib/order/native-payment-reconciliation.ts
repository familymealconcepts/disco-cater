// Reconciliation that doesn't depend on order status — the gap the expiry
// sweep can't close, since it only ever looks at orders CURRENTLY sitting in
// RESERVED. A payment that succeeded in Stripe but whose order got stuck in
// ANY other non-paid state (or whose order row is missing entirely) would
// never surface there. Root cause of the 2026-08-14 incident this exists for:
// no Stripe webhook endpoint is registered for discocater.com at all (checked
// Stripe's own webhook_endpoints list, not our logs — all 9 configured
// endpoints on this shared "FamilyMeal Live" account point at FM's own
// staging/dev domains or long-disabled ngrok tunnels; test mode confirmed,
// live mode needs the same check with the production key). Most orders still
// reach DUE via the direct client-side confirm-payment call right after
// Stripe.js confirms — this sweep is the safety net for the ones where that
// call never lands (closed tab, dropped connection) and no webhook exists to
// catch it either. Same shape as the FM order-reconciliation sweep and the
// expired-invite badge: a periodic "does Stripe's truth match ours" check
// that doesn't require the failure to be visible in any one status bucket.
import Stripe from 'stripe'
import { sql } from '../db'
import { recordOrderEvent } from './native-payment-succeeded'
import { alertOps } from '../ops-alert'

export const DEFAULT_RECONCILIATION_LOOKBACK_HOURS = 26 // > the hourly cadence, so a missed run can't create a gap

const PAID_STATES = new Set(['DUE', 'COMPLETED', 'PAID', 'PARTIAL_REFUND', 'PARTIALLY_PAID', 'REOPEN', 'REFUND', 'REFUNDED'])
const NATIVE_ORDER_KINDS = ['native_order', 'native_recurring_order']

export interface ReconciliationMismatch {
  direction: 'stripe_succeeded_not_paid' | 'local_paid_not_succeeded'
  paymentIntentId: string
  orderReference: string | null
  orderNumber: string | number | null
  orderStatus: string | null
  amount: number | null
  detail: string
}

export interface ReconciliationSummary {
  checkedStripeSucceeded: number
  checkedLocalPaid: number
  mismatches: ReconciliationMismatch[]
}

async function findStripeSucceededSinceByKind(stripe: Stripe, kind: string, sinceEpochSeconds: number): Promise<Stripe.PaymentIntent[]> {
  const all: Stripe.PaymentIntent[] = []
  let page: Stripe.Response<Stripe.ApiSearchResult<Stripe.PaymentIntent>> | undefined
  do {
    page = await stripe.paymentIntents.search({
      query: `status:"succeeded" AND metadata["kind"]:"${kind}" AND created>${sinceEpochSeconds}`,
      limit: 100,
      ...(page?.next_page ? { page: page.next_page } : {}),
    })
    all.push(...page.data)
  } while (page.has_more)
  return all
}

// Direction 1 (the severe one — money taken, nothing to show for it): every
// succeeded native PaymentIntent Stripe knows about, cross-checked against
// the order its own metadata.orderReference points at.
async function checkStripeSucceededAgainstOrders(stripe: Stripe, sinceEpochSeconds: number): Promise<{ checked: number; mismatches: ReconciliationMismatch[] }> {
  const mismatches: ReconciliationMismatch[] = []
  let checked = 0
  for (const kind of NATIVE_ORDER_KINDS) {
    const pis = await findStripeSucceededSinceByKind(stripe, kind, sinceEpochSeconds)
    for (const pi of pis) {
      checked++
      const orderReference = pi.metadata?.orderReference || null
      const orderNumber = pi.metadata?.orderNumber || null
      if (!orderReference) {
        mismatches.push({
          direction: 'stripe_succeeded_not_paid', paymentIntentId: pi.id, orderReference: null, orderNumber, orderStatus: null,
          amount: pi.amount, detail: 'succeeded PaymentIntent tagged as a native order but carries no orderReference metadata',
        })
        continue
      }
      const orders = (await sql`
        SELECT order_number, order_status FROM disco_orders WHERE reference = ${orderReference}::uuid LIMIT 1
      `) as { order_number: string | number; order_status: string }[]
      if (orders.length === 0) {
        mismatches.push({
          direction: 'stripe_succeeded_not_paid', paymentIntentId: pi.id, orderReference, orderNumber, orderStatus: null,
          amount: pi.amount, detail: 'succeeded PaymentIntent — NO MATCHING ORDER ROW AT ALL',
        })
        continue
      }
      const order = orders[0]
      if (!PAID_STATES.has(order.order_status)) {
        mismatches.push({
          direction: 'stripe_succeeded_not_paid', paymentIntentId: pi.id, orderReference, orderNumber: order.order_number,
          orderStatus: order.order_status, amount: pi.amount,
          detail: `succeeded PaymentIntent but order is "${order.order_status}", not a paid state`,
        })
      }
    }
  }
  return { checked, mismatches }
}

// Direction 2 (a different failure mode — our own bookkeeping wrongly
// believes a charge succeeded, e.g. a dispute/reversal we never reflected):
// every LOCAL row we've recorded as SUCCEEDED, cross-checked against Stripe's
// live PaymentIntent state.
async function checkLocalPaidAgainstStripe(stripe: Stripe, sinceIso: string): Promise<{ checked: number; mismatches: ReconciliationMismatch[] }> {
  const rows = (await sql`
    SELECT sp.stripe_payment_intent_id, sp.order_reference, o.order_number, o.order_status
    FROM disco_stripe_payments sp
    JOIN disco_orders o ON o.reference = sp.order_reference
    WHERE sp.status = 'SUCCEEDED' AND sp.created_at >= ${sinceIso}::timestamptz
  `) as { stripe_payment_intent_id: string; order_reference: string; order_number: string | number; order_status: string }[]

  const mismatches: ReconciliationMismatch[] = []
  for (const r of rows) {
    try {
      const pi = await stripe.paymentIntents.retrieve(r.stripe_payment_intent_id)
      if (pi.status !== 'succeeded') {
        mismatches.push({
          direction: 'local_paid_not_succeeded', paymentIntentId: r.stripe_payment_intent_id, orderReference: r.order_reference,
          orderNumber: r.order_number, orderStatus: r.order_status, amount: pi.amount,
          detail: `we recorded this as SUCCEEDED but Stripe now shows "${pi.status}"`,
        })
      }
    } catch (e) {
      // A retrieve failure here (e.g. wrong-mode key) is a "can't verify," not
      // a confirmed mismatch — never flag on an error we can't interpret.
      console.warn(`[native-payment-reconciliation] could not verify ${r.stripe_payment_intent_id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  return { checked: rows.length, mismatches }
}

export async function reconcileNativePayments(
  stripe: Stripe,
  lookbackHours: number = DEFAULT_RECONCILIATION_LOOKBACK_HOURS,
): Promise<ReconciliationSummary> {
  const sinceMs = Date.now() - lookbackHours * 60 * 60 * 1000
  const sinceEpochSeconds = Math.floor(sinceMs / 1000)
  const sinceIso = new Date(sinceMs).toISOString()

  const dir1 = await checkStripeSucceededAgainstOrders(stripe, sinceEpochSeconds)
  const dir2 = await checkLocalPaidAgainstStripe(stripe, sinceIso)

  const mismatches = [...dir1.mismatches, ...dir2.mismatches]

  for (const m of mismatches) {
    await recordOrderEvent(m.orderReference, 'PAYMENT_RECONCILIATION_MISMATCH', m, 'PAYMENT_RECONCILIATION_SWEEP')
    const dollars = m.amount != null ? (m.amount / 100).toFixed(2) : 'unknown'
    // Loud on purpose — this is money taken with no food made (or the reverse:
    // a payment we can no longer verify). alertOps is the same channel every
    // other "someone needs to look at this NOW" condition in this codebase uses.
    await alertOps(
      `URGENT — PAYMENT RECONCILIATION MISMATCH (${m.direction}): PaymentIntent ${m.paymentIntentId} ($${dollars}), ` +
      `order ${m.orderNumber ?? 'UNKNOWN'} (${m.orderReference ?? 'no reference'}), status=${m.orderStatus ?? 'n/a'}. ${m.detail}`,
    )
  }

  return { checkedStripeSucceeded: dir1.checked, checkedLocalPaid: dir2.checked, mismatches }
}
