import type Stripe from 'stripe'
import { sql } from '../db'
import { cents } from '../promo-pricing'

// Issue a REAL Stripe refund for a Disco-native order against its original
// PaymentIntent (from disco_stripe_payments). For a destination charge
// (transfer_data → the restaurant's connected account) we reverse a proportional
// part of the transfer, so the refund is funded from BOTH the restaurant's payout
// and Disco's cut — matching how the money was split, and so the refund doesn't
// fail on insufficient platform balance. For a withheld charge (no transfer) it's a
// plain refund from the platform.
//
// THROWS when there is no linked PaymentIntent or Stripe rejects the refund — the
// caller MUST NOT mark the order refunded (or email the customer) when this throws.
export async function refundNativeOrder(
  stripe: Stripe,
  orderReference: string,
  amountDollars: number,
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
  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: cents(amountDollars),
    ...(hasTransfer ? { reverse_transfer: true } : {}),
  })
  if (refund.status === 'failed' || refund.status === 'canceled') {
    throw new Error(`Stripe refund ${refund.status}`)
  }
  return { refundId: refund.id, status: refund.status || 'unknown', paymentIntentId }
}
