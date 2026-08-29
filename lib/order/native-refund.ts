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

/**
 * Refund a native order AND record every consequence: status, refund total, the
 * audit event, standing down a booked courier, and telling the customer.
 *
 * CURRENTLY UNCALLED, and kept deliberately. It was written for a refund-on-cancel
 * coupling that was then reverted — cancelling is status-only again, by design (see
 * app/api/restaurant/orders/[ref]/status/route.ts). It survives as the migration
 * target for the two refund routes (app/api/admin/orders/[ref]/refund and
 * app/api/restaurant/orders/[ref]/refund), which each carry their own
 * near-identical copy of this block and have already drifted apart — see the
 * migration-candidate entry in docs/native-conversion-runbook.md. Delete it only if
 * that migration is abandoned, not merely because nothing calls it today.
 *
 * THROWS IF THE STRIPE REFUND FAILS, before anything is written — so a caller can
 * never end up with a status change that says money moved when it did not. Callers
 * must let the throw propagate rather than recording anything.
 *
 * @param statusOverride  what to set instead of REFUND/PARTIAL_REFUND, for a caller
 *   that needs the order to land in a different state while `refund` still records
 *   that the money went back.
 */
export async function refundNativeOrderAndRecord(args: {
  stripe: Stripe
  orderReference: string
  amount: number
  alreadyRefunded: number
  orderTotal: number
  source: string
  statusOverride?: string
}): Promise<{ refundId: string; newStatus: string; totalRefund: number }> {
  const { stripe, orderReference, amount, alreadyRefunded, orderTotal, source, statusOverride } = args

  // Stripe FIRST. Nothing below runs if this throws.
  const r = await refundNativeOrder(stripe, orderReference, amount)

  const totalRefund = Math.round((alreadyRefunded + amount) * 100) / 100
  // 'REFUND', not 'REFUNDED' — matches FM's real OrderStatus enum spelling and the
  // majority of stored rows.
  const derived = orderTotal > 0 && totalRefund < orderTotal - 0.001 ? 'PARTIAL_REFUND' : 'REFUND'
  const newStatus = statusOverride || derived

  const rows = (await sql`
    UPDATE disco_orders
    SET order_status = ${newStatus}, refund = ${totalRefund}, updated_at = NOW()
    WHERE reference = ${orderReference}::uuid
    RETURNING reference, order_number, customer_email, customer_first_name, customer_last_name,
              restaurant_reference, restaurant_name, expedite_delivery_id
  `) as Array<{
    reference: string; order_number: string | number | null
    customer_email: string | null; customer_first_name: string | null; customer_last_name: string | null
    restaurant_reference: string | null; restaurant_name: string | null; expedite_delivery_id: string | null
  }>
  const o = rows[0]

  if (o) {
    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${o.reference}::uuid, 'REFUNDED',
              ${JSON.stringify({ amount, totalRefund, stripeRefundId: r.refundId, status: newStatus })}::jsonb,
              ${source})
    `.catch(e => console.error('[native-refund] event insert:', e instanceof Error ? e.message : e))

    // Whole order refunded (not a partial/goodwill adjustment) → stand down any
    // booked courier. A cancel is always a full stand-down.
    const fullyRefunded = derived === 'REFUND'
    if (fullyRefunded && o.expedite_delivery_id && o.expedite_delivery_id !== 'PENDING') {
      try {
        const { cancelDelivery } = await import('../expedite')
        const result = await cancelDelivery(o.expedite_delivery_id)
        console.log('[native-refund] expedite cancel:', result.success ? 'ok' : result.error)
      } catch (e) {
        console.error('[native-refund] expedite cancel failed:', e instanceof Error ? e.message : e)
      }
    }

    // Best-effort, AFTER the money and the row are settled — an email failure must
    // never make a completed refund look failed.
    if (o.customer_email) {
      try {
        const { sendCustomerRefundNotification } = await import('../email/notifications')
        const rc = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${o.restaurant_reference} LIMIT 1`) as { name: string | null }[]
        await sendCustomerRefundNotification({
          to: o.customer_email,
          firstName: o.customer_first_name || '',
          lastName: o.customer_last_name || undefined,
          orderNumber: o.order_number ?? o.reference,
          refundAmount: amount,
          businessName: rc[0]?.name || o.restaurant_name || 'the restaurant',
        })
      } catch (e) {
        console.error('[native-refund] customer refund notification failed:', e instanceof Error ? e.message : e)
      }
    }
  }

  return { refundId: r.refundId, newStatus, totalRefund }
}
