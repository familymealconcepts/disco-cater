import type Stripe from 'stripe'
import { sql } from '../db'
import { cents } from '../promo-pricing'
import { alertOps } from '../ops-alert'

// Issue a REAL Stripe refund for a Disco-native order against its original
// PaymentIntent (from disco_stripe_payments). For a destination charge
// (transfer_data → the restaurant's connected account) we reverse part of the
// transfer, so the refund is funded from BOTH the restaurant's payout and
// Disco's cut — matching how the money was split, and so the refund doesn't
// fail on insufficient platform balance. For a withheld charge (no transfer) it's
// a plain refund from the platform.
//
// `transferReversalDollars` lets a caller that has ALREADY computed the exact
// restaurant-side delta (e.g. an order-edit re-pricing via computeBreakdown)
// pass it explicitly. Stripe's refunds.create has NO parameter to control the
// reversed amount directly — only the boolean `reverse_transfer`, which reverses
// a share proportional to amountDollars/the original charge amount. Verified
// empirically (a real test-mode refund) that this proportional split UNDER-
// reverses once a fixed-dollar component like Stripe's own $0.30 processing fee
// is in the mix (the transfer doesn't scale linearly with the total), so it's
// only exact for a FULL refund. When `transferReversalDollars` is given, the
// refund is issued WITHOUT `reverse_transfer`, and the exact amount is instead
// clawed back via a separate `transfers.createReversal` call — the only Stripe
// API that accepts an explicit reversal amount. Omit the param for a straight
// full/partial refund of an unmodified order — an order edit always has a
// better number and should pass one.
//
// THROWS when there is no linked PaymentIntent or Stripe rejects the refund — the
// caller MUST NOT mark the order refunded (or email the customer) when this throws.
// A failure in the SEPARATE reversal step (after the customer refund already
// succeeded) does NOT throw — the customer-facing refund is real either way; the
// reversal failure is alerted to ops instead, since silently swallowing it would
// leave the restaurant temporarily over-paid with no visibility into why.
export async function refundNativeOrder(
  stripe: Stripe,
  orderReference: string,
  amountDollars: number,
  transferReversalDollars?: number,
): Promise<{ refundId: string; status: string; paymentIntentId: string }> {
  const pays = (await sql`
    SELECT stripe_payment_intent_id FROM disco_stripe_payments
    WHERE order_reference = ${orderReference}::uuid AND stripe_payment_intent_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => [])) as { stripe_payment_intent_id: string }[]
  const paymentIntentId = pays[0]?.stripe_payment_intent_id
  if (!paymentIntentId) throw new Error('No Stripe payment is linked to this order, so it cannot be refunded.')

  const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
  const hasTransfer = !!intent.transfer_data
  const useExactReversal = hasTransfer && transferReversalDollars != null

  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: cents(amountDollars),
    ...(hasTransfer && !useExactReversal ? { reverse_transfer: true } : {}),
  })
  if (refund.status === 'failed' || refund.status === 'canceled') {
    throw new Error(`Stripe refund ${refund.status}`)
  }

  if (useExactReversal && transferReversalDollars > 0) {
    try {
      const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id
      const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null
      const transferId = charge ? (typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id) : undefined
      if (transferId) {
        await stripe.transfers.createReversal(transferId, { amount: cents(transferReversalDollars) })
      } else {
        throw new Error('could not resolve the original transfer id from the charge')
      }
    } catch (e) {
      console.error('[native-refund] exact transfer reversal failed (customer refund already succeeded):', e instanceof Error ? e.message : e)
      await alertOps('native order-edit refund succeeded but the transfer reversal failed', {
        orderReference, paymentIntentId, refundId: refund.id,
        transferReversalDollars, error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return { refundId: refund.id, status: refund.status || 'unknown', paymentIntentId }
}
