import type Stripe from 'stripe'
import { sql } from '../db'

// Statuses meaning the order was already dead before this refund.
const CANCELLED_BEFORE_REFUND = new Set(['CANCELED', 'CANCELLED', 'VOID', 'VOIDED', 'REJECTED'])
import { cents } from '../promo-pricing'
import { alertRefundRefused, alertRefundFromDiscoFunds, alertRestaurantKeptPayout } from './money-alerts'
import { recordMoneyFailure, type RefundVia } from './money-failures'
import { recoverRefundStripeFee } from './refund-stripe-fee'

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
// THROWS when there is no linked PaymentIntent, when Stripe rejects the refund,
// or when the restaurant cannot fund its share of the reversal — the caller MUST
// NOT mark the order refunded (or email the customer) when this throws. Both
// refund routes already honour that.
//
// DISCO DOES NOT SILENTLY COVER A REFUND ON A RESTAURANT'S BEHALF. Where the
// restaurant's share has to be reversed SEPARATELY (an invoice credit note, or
// an order-edit exact reversal), its balance is checked BEFORE the customer's
// money moves and the whole refund is refused if it cannot cover the share — see
// assertReversalIsFunded. Covering a refund is a deliberate decision made case by
// case, never a default the system falls into.
//
// A reversal that fails AFTER that check has passed (the account drained in the
// intervening moment) still does not throw: the customer's refund is real by then
// and must not be un-refunded, so it is alerted to ops instead. That is now the
// rare case rather than the ordinary one.

/**
 * REFUSE A REFUND THE RESTAURANT CANNOT FUND.
 *
 * Disco does not silently cover a refund on a restaurant's behalf. Where Disco
 * does cover one, that is a deliberate, case-by-case decision — never a default
 * the system falls into because a reversal happened to fail after the customer's
 * money had already moved.
 *
 * ── WHY THIS IS A PRE-CHECK AND NOT A RETRY ─────────────────────────────────
 * Both halves of a refund are irreversible in opposite directions: once the
 * credit note (or refund) is issued the customer's money is GONE and must not be
 * un-refunded, while the reversal that was supposed to fund it can still fail.
 * There is no ordering of the two calls that is safe after the fact, and nothing
 * retries a failed reversal — so the only moment this can be decided is BEFORE
 * any money moves.
 *
 * This mirrors what a plain card refund already does by accident of atomicity:
 * `refunds.create({ reverse_transfer: true })` moves both halves in ONE Stripe
 * call, so an unfundable reversal fails the whole refund and the caller throws
 * with nothing moved. That is the behaviour being reproduced here for the two
 * paths that reverse SEPARATELY (invoice credit notes, and order-edit exact
 * reversals), which until now issued the customer's refund first and discovered
 * the shortfall afterwards.
 *
 * THROWS, deliberately. Both refund routes already catch a throw from
 * refundNativeOrder and return it to the operator verbatim without marking the
 * order refunded, writing an event, emailing the customer or standing down the
 * courier — so throwing is what makes "nothing moved" true.
 *
 * ── AVAILABLE *PLUS PENDING* IS THE HEADROOM (changed 21 Oct 2026) ─────────
 * This used to count only the AVAILABLE balance, on the stated belief that "a
 * pending balance cannot fund a reversal". THAT BELIEF WAS WRONG, and it was
 * measured wrong in two independent places:
 *
 *   - LIVE, order #900000448 (The Speakeatery, 20 Oct 2026): available $0.00,
 *     pending $1,967.25. A $22.76 reversal SUCCEEDED and came out of PENDING —
 *     pending fell to $1,944.49 and available never moved. No negative balance.
 *   - TEST MODE, same shape: available $0.00, pending $180.00, reverse $22.76 →
 *     OK, pending $157.24, available $0.00.
 *
 * The practical cost of being wrong was large: every restaurant on a daily
 * automatic payout sits at ~$0 available all day, because the day's takings are
 * swept the moment they clear. So the old rule refused almost every refund on
 * those accounts except inside a ~25-minute window each evening.
 *
 * ── BUT THE CHECK IS STILL LOAD-BEARING, AND STRIPE WILL NOT SAVE US ────────
 * Stripe does NOT refuse a reversal that overdraws the connected account. Also
 * measured in test mode: with available $0.00 AND pending $0.00, a $150.00
 * reversal against a transfer that still had headroom SUCCEEDED and left the
 * account at MINUS $150.00. Nothing errored.
 *
 * Who eats that negative balance depends on the account, and for 35 live
 * restaurants it is Disco:
 *
 *   425  Standard, controller.losses.payments = 'stripe'   → Stripe bears it
 *   129  Standard, classic (controller.type = 'account')   → the account bears it
 *    35  Express,  controller.losses.payments = 'application' → DISCO BEARS IT
 *
 * So the rule is: allow the reversal only when available + pending COVERS it,
 * which is exactly the case where Stripe draws from pending and the balance
 * never goes negative. Beyond that we refuse, and Disco still never silently
 * covers a refund — on any account type.
 *
 * Pending is not risk-free headroom (a pending charge can still be disputed or
 * fail, which would take the balance negative later), but that is a second-order
 * risk on funds that already exist, not the first-order one of overdrawing an
 * account that has nothing in it.
 */
async function assertReversalIsFunded(
  stripe: Stripe,
  destination: string | { id?: string } | null | undefined,
  shareCents: number,
  ctx: Record<string, unknown>,
): Promise<void> {
  const acct = typeof destination === 'string' ? destination : destination?.id
  if (!acct) {
    throw new Error('The restaurant\'s Stripe account could not be identified, so this refund cannot be funded from its payout. No money has moved.')
  }

  const balance = await stripe.balance.retrieve({}, { stripeAccount: acct })
  const sum = (list: Array<{ amount: number; currency: string }> | undefined) =>
    (list ?? []).filter(b => b.currency === 'usd').reduce((t, b) => t + b.amount, 0)
  const available = sum(balance.available)
  const pending = sum(balance.pending)
  // Stripe draws from pending when available is short, so BOTH count as
  // headroom. See the header for the two measurements behind this, and for why
  // the check still refuses beyond it.
  const headroom = available + pending
  if (headroom >= shareCents) return

  const money = (c: number) => `$${(c / 100).toFixed(2)}`
  console.error('[native-refund] refund refused — reversal unfunded', {
    ...ctx, connectedAccountId: acct, reversalNeeded: money(shareCents),
    availableBalance: money(available), pendingBalance: money(pending), combined: money(headroom),
  })
  const refundDollars = Number(String(ctx.refundAmount ?? '').replace(/[$,]/g, '')) || 0
  // Recorded for NM OS's ops watch (lib/order/money-failures.ts), beside the Slack alert.
  await recordMoneyFailure({
    kind: 'refund_refused', via: ctx.via as RefundVia | undefined, orderReference: String(ctx.orderReference ?? ''),
    refundAmount: refundDollars, neededAmount: shareCents / 100, heldAmount: headroom / 100,
  })
  await alertRefundRefused(String(ctx.orderReference ?? ''), {
    refund: refundDollars,
    needed: shareCents / 100, holds: headroom / 100,
  })
  throw new Error(
    `This refund needs ${money(shareCents)} back from the restaurant's Stripe balance, which holds ` +
    `${money(available)} available plus ${money(pending)} pending — ${money(headroom)} in total, ` +
    `${money(shareCents - headroom)} short. Nothing has been refunded and no money has moved. ` +
    `Reversing more than the restaurant holds would put its Stripe balance into the negative, so this is refused ` +
    `rather than covered. The balance usually recovers with the next day's orders — or Disco can choose to cover ` +
    `this refund itself as a deliberate exception.`,
  )
}

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
  via: RefundVia,
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
  // Beyond what the invoice can still credit, the rest comes from the order's
  // OTHER payments (an edit charge or paid edit invoice — #900000228's +$45.86
  // could never be refunded). Planned now, before anything moves.
  const invPi = (invoice as unknown as { payment_intent?: string | { id?: string } | null }).payment_intent
  const invPiId = typeof invPi === 'string' ? invPi : (invPi?.id ?? null)
  const extraSlices = requested > apply ? await planRefundSlices(stripe, orderReference, requested - apply, via, invPiId) : []
  if (apply <= 0 && !extraSlices.length) {
    throw new Error(`This invoice has already been credited in full (${(postCn / 100).toFixed(2)} of ${(amountPaid / 100).toFixed(2)}), so there is nothing left to refund.`)
  }
  if (apply <= 0) return executeRefundSlices(stripe, orderReference, extraSlices, via)

  // ── DECIDE THE RESTAURANT'S SHARE BEFORE THE CUSTOMER'S MONEY MOVES ───────
  // This block used to sit AFTER creditNotes.create, which meant an unfundable
  // reversal was discovered only once the customer had already been refunded —
  // and since a credit note cannot be un-issued, Disco silently absorbed the
  // difference. Order 900000228 is the instance that proved it: $238.00 credited
  // to the customer, $202.19 unrecoverable from a restaurant whose balance had
  // already paid out to its bank, and an ops alert that could only describe the
  // loss after the fact.
  //
  // Resolving the transfer first costs two extra Stripe reads on a path that
  // already makes several, and converts an irreversible loss into a refusal the
  // operator can act on.
  const transferId = rows[0]?.stripe_transfer_id || (await findInvoicePayoutTransfer(stripe, orderReference))
  let pendingReversal: { transferId: string; share: number } | null = null
  // What the proportional share would have been, had nothing else been reversed
  // from the payout first — the rest is collected with the fee (refund-stripe-fee.ts).
  let invShortfall = 0
  if (transferId) {
    const transfer = await stripe.transfers.retrieve(transferId)
    const remaining = transfer.amount - (transfer.amount_reversed ?? 0)
    const intended = Math.round(transfer.amount * (apply / amountPaid))
    const share = Math.min(remaining, intended)
    invShortfall = Math.max(0, intended - Math.max(0, share))
    if (share > 0) {
      // Throws when the restaurant cannot cover it — before the credit note.
      await assertReversalIsFunded(stripe, transfer.destination, share, {
        orderReference, invoiceId, transferId, refundAmount: `$${(apply / 100).toFixed(2)}`, via,
      })
      pendingReversal = { transferId, share }
    }
  } else {
    // NOT a refusal. No transfer means the restaurant was never paid for this
    // order, so Disco is still holding the whole amount and refunding it costs
    // the restaurant nothing — there is simply no share to claw back. Still
    // surfaced, because on an order that SHOULD have paid out it means the
    // payout transfer is missing.
    console.warn('[native-refund] no payout transfer for invoice order — refunding from funds Disco still holds:', orderReference)
    await recordMoneyFailure({ kind: 'refund_from_disco_funds', via, orderReference, refundAmount: apply / 100 })
    await alertRefundFromDiscoFunds(orderReference, { refund: apply / 100, invoiceId })
  }

  // The invoice's charge, read before the credit note, for the Stripe fee the
  // restaurant bears on this refund (recovered after the credit note below).
  const invCharge = (invoice as unknown as { charge?: string | { id?: string } | null }).charge
  const invChargeId = typeof invCharge === 'string' ? invCharge : (invCharge?.id ?? null)
  const invChargeBefore = invChargeId ? await stripe.charges.retrieve(invChargeId).catch(() => null) : null

  const creditNote = await stripe.creditNotes.create({
    invoice: invoiceId,
    amount: apply,
    refund_amount: apply,
    reason: 'product_unsatisfactory',
    memo: `Disco Cater refund for order ${orderReference}`,
  })

  // ── AND TAKE THE RESTAURANT'S SHARE BACK ──────────────────────────────────
  // The balance was checked moments ago, so this is expected to succeed. It is
  // still wrapped: a payout or another refund can drain the account in between,
  // and the customer's money has now moved and must not be un-refunded. The
  // pre-check turns this catch from the normal case into a genuine rarity.
  if (pendingReversal) {
    try {
      await stripe.transfers.createReversal(pendingReversal.transferId, { amount: pendingReversal.share })
    } catch (e) {
      console.error('[native-refund] invoice payout reversal FAILED AFTER a successful balance check — the customer was refunded and the restaurant kept its payout:', orderReference, e instanceof Error ? e.message : e)
      await recordMoneyFailure({
        kind: 'payout_not_reversed', via, orderReference, refundAmount: apply / 100,
        neededAmount: pendingReversal.share / 100, stripeTransferId: pendingReversal.transferId, stripeError: e,
      })
      await alertRestaurantKeptPayout(orderReference, { refund: apply / 100, transferId: pendingReversal.transferId, error: e })
    }
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
  if (invChargeBefore && refundId) {
    const destTransfer = typeof invChargeBefore.transfer === 'string' ? invChargeBefore.transfer : invChargeBefore.transfer?.id ?? null
    await recoverRefundStripeFee({
      stripe, orderReference, chargeId: invChargeBefore.id, refundId, refundCents: apply,
      refundedBeforeCents: invChargeBefore.amount_refunded ?? 0, ownTransferId: transferId || destTransfer, via,
      capShortfallCents: transferId ? invShortfall : undefined,
    })
  }
  if (extraSlices.length) await executeRefundSlices(stripe, orderReference, extraSlices, via)
  return {
    refundId: refundId || creditNote.id,
    status: 'succeeded',
    paymentIntentId: (typeof pi === 'string' ? pi : pi?.id) || '',
  }
}

// ── REFUNDS ACROSS EVERY PAYMENT ON THE ORDER ─────────────────────────────────
// An order edited upward is paid by MORE THAN ONE payment: the checkout charge
// plus an edit charge or a paid edit invoice. The refund used to go entirely to
// the NEWEST payment row, which after an edit is the small edit payment — so a
// larger refund failed at Stripe, and an edit-invoice payment (no
// transfer_data: its payout was a separate transfer) was refunded without
// taking the restaurant's share back, Disco absorbing it.
//
// Now the refund is planned across every successful payment, OLDEST FIRST
// (the checkout charge), up to what each still holds, and refused before
// anything moves if together they can't cover it. Each slice takes the
// restaurant's share back the way that payment paid it out: reverse_transfer on
// a destination charge, or a proportional reversal of the recorded separate
// transfer — balance-checked before the first refund, like the paths below.
interface RefundSlice {
  paymentIntentId: string
  amount: number               // cents refunded from this payment
  reverseTransfer: boolean     // destination charge → Stripe reverses in the same call
  separate: { transferId: string; share: number } | null
  // For the Stripe fee the restaurant bears on a refund (lib/order/refund-stripe-fee.ts).
  chargeId: string
  refundedBefore: number       // cents already refunded on this charge
  ownTransferId: string | null // the transfer that paid this payment out; null = withheld
  capShortfall: number         // separate payout: intended share − what was left to take (cents)
}

async function planRefundSlices(
  stripe: Stripe,
  orderReference: string,
  wantCents: number,
  via: RefundVia,
  excludePaymentIntent?: string | null,
): Promise<RefundSlice[]> {
  const rows = (await sql`
    SELECT stripe_payment_intent_id, stripe_transfer_id FROM disco_stripe_payments
     WHERE order_reference = ${orderReference}::uuid AND status = 'SUCCEEDED'
       AND stripe_payment_intent_id LIKE 'pi_%'
     ORDER BY created_at ASC, id ASC
  `.catch(() => [])) as { stripe_payment_intent_id: string; stripe_transfer_id: string | null }[]
  const slices: RefundSlice[] = []
  let left = wantCents
  let capacity = 0
  for (const r of rows) {
    if (left <= 0) break
    if (excludePaymentIntent && r.stripe_payment_intent_id === excludePaymentIntent) continue
    const intent = await stripe.paymentIntents.retrieve(r.stripe_payment_intent_id)
    const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id
    if (!chargeId) continue
    const charge = await stripe.charges.retrieve(chargeId)
    const holds = (charge.amount_captured ?? charge.amount) - (charge.amount_refunded ?? 0)
    if (holds <= 0) continue
    capacity += holds
    const take = Math.min(holds, left)
    const hasTransfer = !!intent.transfer_data
    let separate: RefundSlice['separate'] = null
    let capShortfall = 0
    // A payment paid out by a SEPARATE transfer (an edit invoice) — its id is on
    // the payment row from now on; older ones are found by the charge they paid
    // out of (source_transaction), within the order's transfer group.
    let separateId = r.stripe_transfer_id
    if (!hasTransfer && !separateId) {
      try {
        const list = await stripe.transfers.list({ transfer_group: orderReference, limit: 20 })
        separateId = list.data.find(t => (typeof t.source_transaction === 'string' ? t.source_transaction : t.source_transaction?.id) === chargeId)?.id ?? null
      } catch { /* none found — refunded from funds Disco holds, as before */ }
    }
    if (!hasTransfer && separateId) {
      const transfer = await stripe.transfers.retrieve(separateId)
      const remaining = transfer.amount - (transfer.amount_reversed ?? 0)
      const intended = Math.round(transfer.amount * (take / (charge.amount_captured ?? charge.amount)))
      const share = Math.min(remaining, intended)
      capShortfall = Math.max(0, intended - Math.max(0, share))
      if (share > 0) {
        await assertReversalIsFunded(stripe, transfer.destination, share, {
          orderReference, paymentIntentId: r.stripe_payment_intent_id, transferId: separateId,
          refundAmount: `$${(take / 100).toFixed(2)}`, via,
        })
        separate = { transferId: separateId, share }
      }
    }
    const destTransfer = typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id ?? null
    slices.push({
      paymentIntentId: r.stripe_payment_intent_id, amount: take, reverseTransfer: hasTransfer, separate,
      chargeId, refundedBefore: charge.amount_refunded ?? 0,
      ownTransferId: hasTransfer ? destTransfer : (separateId ?? null), capShortfall,
    })
    left -= take
  }
  if (left > 0) {
    throw new Error(`Only $${((wantCents - left) / 100).toFixed(2)} of this order's payments can still be refunded${capacity ? '' : ' (no refundable payment is linked)'}. No money has moved.`)
  }
  return slices
}

async function executeRefundSlices(
  stripe: Stripe,
  orderReference: string,
  slices: RefundSlice[],
  via: RefundVia,
): Promise<{ refundId: string; status: string; paymentIntentId: string }> {
  let first: { refundId: string; status: string; paymentIntentId: string } | null = null
  for (const s of slices) {
    const refund = await stripe.refunds.create({
      payment_intent: s.paymentIntentId,
      amount: s.amount,
      ...(s.reverseTransfer ? { reverse_transfer: true } : {}),
    })
    if (refund.status === 'failed' || refund.status === 'canceled') {
      throw new Error(`Stripe refund ${refund.status}${first ? ' (an earlier part of this refund already went through — see the order)' : ''}`)
    }
    if (s.separate) {
      try {
        await stripe.transfers.createReversal(s.separate.transferId, { amount: s.separate.share })
      } catch (e) {
        console.error('[native-refund] edit-payment payout reversal FAILED after a successful balance check:', orderReference, e instanceof Error ? e.message : e)
        await recordMoneyFailure({
          kind: 'payout_not_reversed', via, orderReference, refundAmount: s.amount / 100,
          neededAmount: s.separate.share / 100, stripeTransferId: s.separate.transferId, stripeError: e,
        })
        await alertRestaurantKeptPayout(orderReference, { refund: s.amount / 100, transferId: s.separate.transferId, error: e })
      }
    }
    // The restaurant bears the refunded share of the Stripe fee. After the
    // customer's refund, never blocks or undoes it.
    await recoverRefundStripeFee({
      stripe, orderReference, chargeId: s.chargeId, refundId: refund.id, refundCents: s.amount,
      refundedBeforeCents: s.refundedBefore, ownTransferId: s.ownTransferId, via,
      // reverse_transfer: read off Stripe's own reversal; separate payout: measured above.
      capShortfallCents: s.reverseTransfer ? undefined : s.capShortfall,
    })
    first ??= { refundId: refund.id, status: refund.status || 'unknown', paymentIntentId: s.paymentIntentId }
  }
  if (!first) throw new Error('Nothing to refund.')
  return first
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
  opts?: { via?: RefundVia },
): Promise<{ refundId: string; status: string; paymentIntentId: string }> {
  // Which caller started this refund, stored with any failure (lib/order/money-failures.ts).
  const via: RefundVia = opts?.via ?? 'unknown'
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
  const viaInvoice = await refundNativeInvoiceOrder(stripe, orderReference, amountDollars, via)
  if (viaInvoice) return viaInvoice

  // An ordinary refund is spread across the order's payments (planRefundSlices).
  if (transferReversalDollars == null) {
    const slices = await planRefundSlices(stripe, orderReference, cents(amountDollars), via)
    return executeRefundSlices(stripe, orderReference, slices, via)
  }

  // An EDIT's refund passes the exact payout change; it comes off the checkout
  // charge — the payment whose transfer the edit re-priced — the oldest one.
  const pays = (await sql`
    SELECT stripe_payment_intent_id FROM disco_stripe_payments
    WHERE order_reference = ${orderReference}::uuid AND status = 'SUCCEEDED' AND stripe_payment_intent_id LIKE 'pi_%'
    ORDER BY created_at ASC, id ASC LIMIT 1
  `.catch(() => [])) as { stripe_payment_intent_id: string }[]
  const paymentIntentId = pays[0]?.stripe_payment_intent_id
  if (!paymentIntentId) throw new Error('No Stripe payment is linked to this order, so it cannot be refunded.')

  const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
  const hasTransfer = !!intent.transfer_data
  const useExactReversal = hasTransfer && transferReversalDollars != null

  // ── THE SAME PRE-CHECK, FOR THE SAME REASON ───────────────────────────────
  // An EXACT reversal is a separate transfers.createReversal AFTER the refund,
  // so it carries the identical exposure the invoice path did: customer refunded,
  // reversal rejected for insufficient funds, Disco absorbing the difference.
  // The plain `reverse_transfer: true` branch below needs no check — Stripe moves
  // both halves in one call and fails the refund itself if the reversal cannot
  // be funded, which already leaves nothing moved.
  let exactReversal: { transferId: string; amount: number } | null = null
  const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id
  const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null
  if (useExactReversal && transferReversalDollars > 0) {
    const transferId = charge ? (typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id) : undefined
    if (!transferId) {
      throw new Error('The original payout transfer for this order could not be found, so the restaurant\'s share of this refund cannot be taken back. No money has moved.')
    }
    const transfer = await stripe.transfers.retrieve(transferId)
    const amount = cents(transferReversalDollars)
    await assertReversalIsFunded(stripe, transfer.destination, amount, {
      orderReference, paymentIntentId, transferId, refundAmount: `$${amountDollars.toFixed(2)}`, via,
    })
    exactReversal = { transferId, amount }
  }

  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: cents(amountDollars),
    ...(hasTransfer && !useExactReversal ? { reverse_transfer: true } : {}),
  })
  if (refund.status === 'failed' || refund.status === 'canceled') {
    throw new Error(`Stripe refund ${refund.status}`)
  }

  if (exactReversal) {
    try {
      await stripe.transfers.createReversal(exactReversal.transferId, { amount: exactReversal.amount })
    } catch (e) {
      console.error('[native-refund] exact transfer reversal failed AFTER a successful balance check (customer refund already succeeded):', e instanceof Error ? e.message : e)
      await recordMoneyFailure({
        kind: 'payout_not_reversed', via, orderReference, refundAmount: amountDollars,
        neededAmount: exactReversal.amount / 100, stripeTransferId: exactReversal.transferId, stripeError: e,
      })
      await alertRestaurantKeptPayout(orderReference, { refund: amountDollars, transferId: exactReversal.transferId, error: e })
    }
  }

  // The restaurant bears the refunded share of the Stripe fee (an edit's
  // transfer delta re-prices Disco's ESTIMATE of the fee, which Stripe never
  // actually returns). Withheld payouts have no transfer and are skipped.
  if (charge && hasTransfer) {
    await recoverRefundStripeFee({
      stripe, orderReference, chargeId: charge.id, refundId: refund.id, refundCents: cents(amountDollars),
      refundedBeforeCents: charge.amount_refunded ?? 0,
      ownTransferId: typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id ?? null, via,
      // An edit's exact reversal is explicit and refuses rather than caps.
      capShortfallCents: exactReversal ? 0 : undefined,
    })
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
      // Recorded on the order and alerted on failure (never throws).
      const { cancelCourierAndReport } = await import('./courier-sync')
      await cancelCourierAndReport(o.reference, String(source), 'refunded')
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
