import type Stripe from 'stripe'
import { sql } from '../db'

// Statuses meaning the order was already dead before this refund.
const CANCELLED_BEFORE_REFUND = new Set(['CANCELED', 'CANCELLED', 'VOID', 'VOIDED', 'REJECTED'])
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

/**
 * REFUNDING AN INVOICE-PATH ORDER — credit note, then transfer reversal.
 *
 * ── WHY THIS IS SEPARATE FROM THE CARD PATH ─────────────────────────────────
 * A card order is a destination charge: the payout rides inside the charge as
 * transfer_data, so a refund can hand Stripe `reverse_transfer: true` and both
 * halves move together. An invoice order is not. Disco's invoice is created on
 * the PLATFORM account and the restaurant is paid afterwards by a SEPARATE
 * transfers.create in the webhook. So there is no transfer_data to reverse, and
 * the two halves have to be moved explicitly:
 *
 *   1. a credit note on the paid invoice, which returns the customer's money
 *   2. a transfer reversal, which takes the restaurant's payout back
 *
 * Without step 2 the customer is made whole out of Disco's own pocket.
 *
 * ── FAMILYMEAL IS THE SPECIFICATION FOR STEP 1 ──────────────────────────────
 * FM returns money on an invoice with a credit note, not a PaymentIntent refund
 * — StripeServiceImpl.issueCreditNoteOnPaidInvoice, which requires the invoice
 * to be paid and caps the amount by Stripe-reported headroom:
 *
 *     long amountPaid = inv.getAmountPaid() != null ? inv.getAmountPaid() : 0L;
 *     long postCn = inv.getPostPaymentCreditNotesAmount() != null ? inv.getPostPaymentCreditNotesAmount() : 0L;
 *     long headroom = Math.max(0L, amountPaid - postCn);
 *     long applyCents = Math.min(requestedCents, headroom);
 *
 * That headroom cap is what stops a second refund double-crediting the same
 * invoice, and it is reproduced exactly below.
 *
 * FM passes only `setAmount`. On the API version this codebase pins
 * (2025-01-27.acacia) Stripe REJECTS that on a paid invoice — verified in test
 * mode: "The sum of refunds, credit amount, and out of band amount ($0.00) must
 * equal the credit note post_payment_amount ($139.15)." So `refund_amount` is
 * passed alongside `amount`, which is what actually returns cash to the card.
 *
 * ── THE PARTIAL RULE ────────────────────────────────────────────────────────
 * The restaurant's share is reversed PROPORTIONALLY to the amount refunded,
 * which is what Stripe's own `reverse_transfer: true` does on the card path —
 * so a partial refund moves the same money whichever way the order was paid.
 */
async function refundNativeInvoiceOrder(
  stripe: Stripe,
  orderReference: string,
  amountDollars: number,
): Promise<{ refundId: string; status: string; paymentIntentId: string } | null> {
  const rows = (await sql`
    SELECT o.stripe_invoice_id,
           (SELECT p.stripe_transfer_id FROM disco_stripe_payments p
             WHERE p.order_reference = o.reference AND p.stripe_transfer_id IS NOT NULL
             ORDER BY p.created_at DESC LIMIT 1) AS stripe_transfer_id
      FROM disco_orders o WHERE o.reference = ${orderReference}::uuid LIMIT 1
  `.catch(() => [])) as { stripe_invoice_id: string | null; stripe_transfer_id: string | null }[]
  const invoiceId = rows[0]?.stripe_invoice_id
  if (!invoiceId) return null   // not an invoice order — caller keeps its own error

  const invoice = await stripe.invoices.retrieve(invoiceId)
  if (invoice.status !== 'paid') {
    throw new Error(`This order's invoice is ${invoice.status}, not paid, so there is nothing to refund. Void the invoice instead.`)
  }

  // FM's headroom rule, exactly.
  const amountPaid = invoice.amount_paid ?? 0
  const postCn = invoice.post_payment_credit_notes_amount ?? 0
  const headroom = Math.max(0, amountPaid - postCn)
  const requested = cents(amountDollars)
  const apply = Math.min(requested, headroom)
  if (apply <= 0) {
    throw new Error(`This invoice has already been credited in full (${(postCn / 100).toFixed(2)} of ${(amountPaid / 100).toFixed(2)}), so there is nothing left to refund.`)
  }

  const creditNote = await stripe.creditNotes.create({
    invoice: invoiceId,
    amount: apply,
    refund_amount: apply,
    reason: 'product_unsatisfactory',
    memo: `Disco Cater refund for order ${orderReference}`,
  })

  // ── AND TAKE THE RESTAURANT'S SHARE BACK ──────────────────────────────────
  // Best-effort in the sense that the customer's money has already moved and
  // must not be un-refunded — but never silent: a failure here means Disco is
  // covering the difference, so it is surfaced to ops.
  const transferId = rows[0]?.stripe_transfer_id || (await findInvoicePayoutTransfer(stripe, orderReference))
  if (transferId) {
    try {
      const transfer = await stripe.transfers.retrieve(transferId)
      const remaining = transfer.amount - (transfer.amount_reversed ?? 0)
      const share = Math.min(remaining, Math.round(transfer.amount * (apply / amountPaid)))
      if (share > 0) {
        await stripe.transfers.createReversal(transferId, { amount: share })
      }
    } catch (e) {
      console.error('[native-refund] invoice payout reversal FAILED — the customer was refunded and the restaurant kept its payout:', orderReference, e instanceof Error ? e.message : e)
      await alertOps('invoice refund issued but the restaurant payout was NOT reversed', {
        orderReference, invoiceId, creditNoteId: creditNote.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  } else {
    console.error('[native-refund] no payout transfer found to reverse for invoice order:', orderReference)
    await alertOps('invoice refund issued but no payout transfer could be found to reverse', { orderReference, invoiceId, creditNoteId: creditNote.id })
  }

  // The credit note reports its refund under `refunds[]` on current API versions
  // and under a flat `refund` on the pinned one; test mode returns BOTH. Read the
  // array first (it is what the SDK types describe) and fall back to the flat field.
  const cn = creditNote as unknown as {
    refunds?: Array<{ refund?: string | { id?: string } | null }> | null
    refund?: string | { id?: string } | null
  }
  const fromArray = cn.refunds?.[0]?.refund
  const fromFlat = cn.refund
  const pick = (v: string | { id?: string } | null | undefined) => (typeof v === 'string' ? v : v?.id)
  const refundId = pick(fromArray) || pick(fromFlat)
  const pi = (invoice as unknown as { payment_intent?: string | { id?: string } | null }).payment_intent
  return {
    refundId: refundId || creditNote.id,
    status: 'succeeded',
    paymentIntentId: (typeof pi === 'string' ? pi : pi?.id) || '',
  }
}

/** Last-resort lookup when the transfer id was never recorded (orders paid before that column existed). */
async function findInvoicePayoutTransfer(stripe: Stripe, orderReference: string): Promise<string | null> {
  try {
    const list = await stripe.transfers.list({ transfer_group: orderReference, limit: 10 })
    const hit = list.data.find(t => t.metadata?.kind === 'native_invoice_payout') || list.data[0]
    return hit?.id ?? null
  } catch { return null }
}

export async function refundNativeOrder(
  stripe: Stripe,
  orderReference: string,
  amountDollars: number,
  transferReversalDollars?: number,
): Promise<{ refundId: string; status: string; paymentIntentId: string }> {
  // ── KEYED ON THE ORDER, NOT ON WHAT HAPPENS TO BE RECORDED ────────────────
  // Checked FIRST. An invoice-path order does have a PaymentIntent — the one
  // that paid the invoice — and the webhook now records it, so testing for a
  // missing payment row would never route here and the refund would fall
  // through to a plain PaymentIntent refund: the customer made whole, the
  // restaurant's payout untouched, and Disco absorbing the difference. Verified
  // in test mode before this was moved: charge.amount_refunded=13915 with
  // transfer.amount_reversed=0.
  //
  // disco_orders.stripe_invoice_id is set only by placeNativeInvoiceOrder
  // (native-checkout.ts). Order-EDIT invoices use pending_stripe_invoice_id, so
  // a card order that was later edited is not mistaken for an invoice order.
  const viaInvoice = await refundNativeInvoiceOrder(stripe, orderReference, amountDollars)
  if (viaInvoice) return viaInvoice

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

  // The `prior` join captures order_status BEFORE this statement overwrites it.
  // UPDATE ... RETURNING gives the NEW row, and the OLD status is the only way to
  // know whether a partially-refunded order had already been cancelled — which
  // decides whether the customer email may say the order is still going ahead.
  // Done in the same statement so there is no window between read and write.
  const rows = (await sql`
    UPDATE disco_orders o
    SET order_status = ${newStatus}, refund = ${totalRefund}, updated_at = NOW()
    FROM (SELECT reference, order_status FROM disco_orders WHERE reference = ${orderReference}::uuid) prior
    WHERE o.reference = prior.reference
    RETURNING o.reference, o.order_number, o.customer_email, o.customer_first_name, o.customer_last_name,
              o.restaurant_reference, o.restaurant_name, o.expedite_delivery_id,
              prior.order_status AS prior_status
  `) as Array<{
    reference: string; order_number: string | number | null
    customer_email: string | null; customer_first_name: string | null; customer_last_name: string | null
    restaurant_reference: string | null; restaurant_name: string | null; expedite_delivery_id: string | null
    prior_status: string | null
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
    // never make a completed refund look failed. DISCO-source only; the helper
    // owns both the filter and the recipient lookup.
    const { sendOrderRefundEmail } = await import('./refund-email')
    await sendOrderRefundEmail({
      orderReference: o.reference,
      amount,
      totalRefunded: totalRefund,
      orderTotal,
      isPartial: newStatus === 'PARTIAL_REFUND',
      // See the note on the UPDATE above: a partial refund on an already
      // cancelled order must not tell the customer it is still happening.
      orderProceeding: newStatus !== 'PARTIAL_REFUND'
        ? undefined
        : !CANCELLED_BEFORE_REFUND.has(String(o.prior_status || '').toUpperCase()),
    })
  }

  return { refundId: r.refundId, newStatus, totalRefund }
}
