// THE RESTAURANT BEARS THE STRIPE FEE ON A REFUND (Peter, 29 Oct 2026).
//
// Stripe keeps its processing fee when a charge is refunded. The restaurant's
// payout was already net of that fee (transfer_data.amount = total − Disco's fee
// − Stripe's fee), so a refund that only reversed the restaurant's share left
// Disco paying the fee: #900000747 refunded $368.05, Francesca returned its whole
// $347.96, Disco returned $20.09 and was down $10.97. $151.30 across 28 refunds
// before this rule.
//
// After every refund of a Disco payment that paid the restaurant out, the
// refunded share of the charge's Stripe fee is taken back from the restaurant by
// transfer reversal:
//   1. from the order's OWN payout, while it has room (a partial refund);
//   2. then from the restaurant's OTHER recent payouts, newest first (a full
//      refund has already reversed the order's own payout to zero, and Stripe
//      refuses to reverse a transfer past its amount);
//   3. what neither covers is recorded as UNCOLLECTED and ops is alerted: Disco
//      covers it until Super Admin's "Recover Stripe fee" takes it from a later
//      payout (recoverOutstandingRefundFees).
//
// Never more than the restaurant's Stripe balance holds (available + pending),
// for the same reason as assertReversalIsFunded in native-refund.ts: Stripe does
// not refuse a reversal that overdraws an account, and for Express accounts Disco
// bears a negative balance.
//
// RUNS AFTER THE CUSTOMER'S REFUND AND NEVER THROWS. The customer always gets back
// exactly the refunded amount; collecting the fee can only succeed, fall short
// (recorded + alerted), or fail (recorded + alerted). A payment with no payout to
// the restaurant (payouts withheld) is skipped: Disco is holding the restaurant's
// money, so there is nothing to take the fee from.
//
// Table: lib/migrations/010_disco_refund_stripe_fees.sql. Past refunds are not
// recovered — only refunds that run through here.
import type Stripe from 'stripe'
import { sql } from '../db'
import { alertOps } from '../ops-alert'
import { orderLink } from '../ops-alert-format'
import type { RefundVia } from './money-failures'
import { refundFeeBasisCents } from './stripe-fee-trueup'

type Source = { transferId: string; reversalId: string; amount: number; how: 'own_payout' | 'other_payout'; manual?: boolean; by?: string | null; at: string }

export interface FeeRecoveryInput {
  stripe: Stripe
  orderReference: string
  chargeId: string
  /** The Stripe refund (or credit-note refund) this fee belongs to. Idempotency key. */
  refundId: string
  refundCents: number
  /** charge.amount_refunded BEFORE this refund — keeps proportional rounding exact across partials. */
  refundedBeforeCents: number
  /** The transfer that paid this payment out to the restaurant. Null → payouts were withheld; skipped. */
  ownTransferId: string | null
  via: RefundVia
  /**
   * For a payout reversed by an EXPLICIT reversal capped at what was left on the
   * transfer (invoice and edit-payment refunds): intended − taken, in cents. Left
   * out for reverse_transfer refunds, where it is read off Stripe's own reversal.
   */
  capShortfallCents?: number
}

export interface FeeRecoveryResult { feeCents: number; recoveredCents: number; uncollectedCents: number; sources: Source[] }

const money = (c: number) => `$${(c / 100).toFixed(2)}`
const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null)

/** The refunded share of the charge's Stripe fee, in cents. Cumulative, so partials never drift by a cent. */
export function refundFeeShare(feeCents: number, capturedCents: number, refundedBeforeCents: number, refundCents: number): number {
  if (feeCents <= 0 || capturedCents <= 0 || refundCents <= 0) return 0
  const after = Math.min(capturedCents, refundedBeforeCents + refundCents)
  const before = Math.min(capturedCents, refundedBeforeCents)
  return Math.max(0, Math.round(feeCents * after / capturedCents) - Math.round(feeCents * before / capturedCents))
}

async function headroomCents(stripe: Stripe, acct: string): Promise<number> {
  const b = await stripe.balance.retrieve({}, { stripeAccount: acct })
  const sum = (l: Array<{ amount: number; currency: string }> | undefined) => (l ?? []).filter(x => x.currency === 'usd').reduce((t, x) => t + x.amount, 0)
  return Math.max(0, sum(b.available) + sum(b.pending))
}

/**
 * Take up to `needCents` back from the restaurant: the order's own payout first
 * (when given), then its other recent payouts, newest first. Bounded by the
 * account's balance. Returns the reversals made.
 */
async function collect(
  stripe: Stripe, acct: string, needCents: number, refundId: string, orderReference: string,
  ownTransferId: string | null, opts: { manual?: boolean; by?: string | null; keySuffix?: string } = {},
): Promise<Source[]> {
  const out: Source[] = []
  let need = needCents
  let room = await headroomCents(stripe, acct).catch(() => 0)
  const reverse = async (t: Stripe.Transfer, how: Source['how']) => {
    const left = t.amount - (t.amount_reversed ?? 0)
    const take = Math.min(left, need, room)
    if (take <= 0) return
    const rev = await stripe.transfers.createReversal(t.id, {
      amount: take,
      description: `Stripe fee on refund ${refundId}`,
      metadata: { kind: 'refund_stripe_fee', orderReference, refundId, ...(opts.manual ? { manual: '1' } : {}) },
    }, { idempotencyKey: `refund-fee:${refundId}:${t.id}${opts.keySuffix ?? ''}` })
    out.push({ transferId: t.id, reversalId: rev.id, amount: take, how, ...(opts.manual ? { manual: true, by: opts.by ?? null } : {}), at: new Date().toISOString() })
    need -= take
    room -= take
  }
  if (ownTransferId && need > 0 && room > 0) {
    await reverse(await stripe.transfers.retrieve(ownTransferId), 'own_payout')
  }
  if (need > 0 && room > 0) {
    // The restaurant's recent payouts, newest first (Stripe lists newest first).
    const recent = await stripe.transfers.list({ destination: acct, limit: 100 })
    for (const t of recent.data) {
      if (need <= 0 || room <= 0) break
      if (t.id === ownTransferId || t.reversed) continue
      await reverse(t, 'other_payout')
    }
  }
  return out
}

async function orderLabel(orderReference: string): Promise<{ number: string; restaurant: string; restaurantRef: string | null }> {
  const r = (await sql`
    SELECT order_number::text AS n, restaurant_name AS r, restaurant_reference::text AS rr FROM disco_orders WHERE reference = ${orderReference}::uuid LIMIT 1
  `.catch(() => [])) as { n: string; r: string | null; rr: string | null }[]
  return { number: r[0]?.n ?? '', restaurant: r[0]?.r ?? 'the restaurant', restaurantRef: r[0]?.rr ?? null }
}

async function alertUncollected(orderReference: string, label: { number: string; restaurant: string }, uncollectedCents: number, feeCents: number, why: string) {
  await alertOps({
    severity: 'warn',
    headline: `Stripe fee on a refund not collected — order #${label.number}`,
    lines: [
      `${label.restaurant} · order #${label.number}`,
      `The refund went through. Its Stripe fee is ${money(feeCents)}; ${money(uncollectedCents)} could not be taken back from the restaurant (${why}), so Disco is covering ${money(uncollectedCents)} for now.`,
    ],
    action: 'use "Recover Stripe fee" on the order in Super Admin once the restaurant has a new payout.',
    link: orderLink(orderReference, label.number),
    context: { orderReference, uncollected: uncollectedCents / 100, fee: feeCents / 100 },
  }).catch(e => console.error('[refund-stripe-fee] alert failed (non-fatal):', e instanceof Error ? e.message : e))
}

/**
 * What Stripe's proportional reversal on this refund should have taken but could
 * not, in cents (Peter's decision 3, 29 Oct 2026).
 *
 * `reverse_transfer: true` reverses refund ÷ charge × the transfer's ORIGINAL
 * amount — but never more than is left on the transfer, and Stripe caps it
 * silently. Anything else already reversed from that transfer (a fee taken on an
 * earlier partial refund, a Stripe-fee true-up, another order's fee) is therefore
 * handed back to the restaurant by the refund that empties it. Measured in test
 * mode: $100 charge, $90 transfer, 40% refund + $1.28 fee from the payout, then
 * the other 60% reversed $52.72 instead of $54.00.
 */
export function capShortfallCents(transferAmount: number, refundCents: number, capturedCents: number, reversedByRefund: number): number {
  if (capturedCents <= 0 || refundCents <= 0) return 0
  const expected = Math.round(transferAmount * Math.min(1, refundCents / capturedCents))
  const short = expected - reversedByRefund
  return short > 1 ? short : 0   // a cent is Stripe's rounding, not a cap
}

/** The reverse_transfer reversal Stripe made for this refund, if any, in cents. */
async function refundReversalCents(stripe: Stripe, refundId: string): Promise<number | null> {
  if (!refundId.startsWith('re_')) return null
  const r = await stripe.refunds.retrieve(refundId, { expand: ['transfer_reversal'] }).catch(() => null)
  const rev = (r as unknown as { transfer_reversal?: Stripe.TransferReversal | string | null } | null)?.transfer_reversal
  return rev && typeof rev === 'object' ? rev.amount : null
}

/**
 * Claim, collect and record one amount the restaurant owes for a refund. The row
 * key is the refund id (or `<refund>:shortfall`), so a retry never collects twice.
 */
async function takeBack(i: FeeRecoveryInput, acct: string, label: { number: string; restaurant: string; restaurantRef: string | null },
  key: string, cents: number, via: string, what: string): Promise<{ recovered: number; uncollected: number; sources: Source[] } | null> {
  const claimed = (await sql`
    INSERT INTO disco_refund_stripe_fees
      (order_reference, restaurant_reference, stripe_refund_id, stripe_charge_id, connected_account_id, via, refund_amount, fee_amount, status)
    VALUES (${i.orderReference}, ${label.restaurantRef}, ${key}, ${i.chargeId}, ${acct}, ${via}, ${i.refundCents / 100}, ${cents / 100}, 'pending')
    ON CONFLICT (stripe_refund_id) DO NOTHING
    RETURNING id
  `) as { id: number }[]
  if (!claimed.length) return null

  let sources: Source[] = []
  let error: unknown = null
  try { sources = await collect(i.stripe, acct, cents, key, i.orderReference, i.ownTransferId) } catch (e) { error = e }
  const recovered = sources.reduce((t, s) => t + s.amount, 0)
  const uncollected = cents - recovered
  await sql`
    UPDATE disco_refund_stripe_fees
       SET recovered_amount = ${recovered / 100}, sources = ${JSON.stringify(sources)}::jsonb,
           status = ${uncollected > 0 ? 'uncollected' : 'recovered'}, updated_at = NOW()
     WHERE id = ${claimed[0].id}
  `
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    VALUES (${i.orderReference}::uuid, ${uncollected > 0 ? 'REFUND_STRIPE_FEE_UNCOLLECTED' : 'REFUND_STRIPE_FEE_RECOVERED'},
            ${JSON.stringify({ refundId: i.refundId, what, amount: cents / 100, recovered: recovered / 100, uncollected: uncollected / 100, sources, ...(error ? { error: String(error instanceof Error ? error.message : error).slice(0, 300) } : {}) })}::jsonb,
            'REFUND_STRIPE_FEE')
  `.catch(e => console.error('[refund-stripe-fee] event (non-fatal):', e instanceof Error ? e.message : e))
  if (uncollected > 0) {
    const why = error ? `Stripe error: ${String(error instanceof Error ? error.message : error).slice(0, 120)}` : 'no payout or balance with room'
    await alertUncollected(i.orderReference, label, uncollected, cents, why)
  }
  return { recovered, uncollected, sources }
}

/** After a refund: take the refunded share of the Stripe fee back from the restaurant. Never throws. */
export async function recoverRefundStripeFee(i: FeeRecoveryInput): Promise<FeeRecoveryResult | null> {
  try {
    if (!i.ownTransferId || !i.chargeId || !i.refundId || i.refundCents <= 0) return null
    const charge = await i.stripe.charges.retrieve(i.chargeId, { expand: ['balance_transaction'] })
    const bt = charge.balance_transaction as Stripe.BalanceTransaction | string | null
    const feeActual = bt && typeof bt === 'object' ? bt.fee : (bt ? (await i.stripe.balanceTransactions.retrieve(bt)).fee : 0)
    // After a true-up the restaurant has already paid Stripe's actual fee in full;
    // the refunded share is then of the estimate (lib/order/stripe-fee-trueup.ts).
    const feeTotal = await refundFeeBasisCents(i.chargeId, feeActual)
    const captured = charge.amount_captured || charge.amount
    const feeCents = refundFeeShare(feeTotal, captured, i.refundedBeforeCents, i.refundCents)
    const own = await i.stripe.transfers.retrieve(i.ownTransferId)
    const acct = idOf(own.destination)
    if (!acct) return null
    // The part of this refund's payout reversal that Stripe could not take because
    // the transfer was already emptied by earlier non-refund reversals.
    let shortfall = i.capShortfallCents ?? 0
    if (i.capShortfallCents == null) {
      const rev = await refundReversalCents(i.stripe, i.refundId)
      if (rev != null) shortfall = capShortfallCents(own.amount, i.refundCents, captured, rev)
    }
    if (feeCents <= 0 && shortfall <= 0) return null
    const label = await orderLabel(i.orderReference)

    const fee = feeCents > 0 ? await takeBack(i, acct, label, i.refundId, feeCents, i.via, 'stripe_fee') : null
    const short = shortfall > 0 ? await takeBack(i, acct, label, `${i.refundId}:shortfall`, shortfall, SHORTFALL_VIA, 'payout_reversal_shortfall') : null
    if (!fee && !short) return null
    return {
      feeCents, recoveredCents: (fee?.recovered ?? 0) + (short?.recovered ?? 0),
      uncollectedCents: (fee?.uncollected ?? 0) + (short?.uncollected ?? 0),
      sources: [...(fee?.sources ?? []), ...(short?.sources ?? [])],
    }
  } catch (e) {
    console.error('[refund-stripe-fee] recovery failed (non-fatal — the customer refund stands):', i.orderReference, e instanceof Error ? e.message : e)
    return null
  }
}

/** `via` on a shortfall row: the restaurant's payout reversal Stripe capped, not a Stripe fee. */
export const SHORTFALL_VIA = 'cap_shortfall'

/**
 * Super Admin's "Recover Stripe fee": for every uncollected fee on the order,
 * take what is still owed from the restaurant's payouts (newest first, own payout
 * included), bounded by its balance, and record it. Returns what moved.
 */
export async function recoverOutstandingRefundFees(stripe: Stripe, orderReference: string, actorEmail: string | null): Promise<{ recoveredCents: number; stillOwedCents: number }> {
  const rows = (await sql`
    SELECT id, stripe_refund_id, stripe_charge_id, connected_account_id,
           ROUND(fee_amount * 100)::int AS fee, ROUND(recovered_amount * 100)::int AS rec, sources
      FROM disco_refund_stripe_fees
     WHERE order_reference = ${orderReference} AND status = 'uncollected'
     ORDER BY id
  `) as Array<{ id: number; stripe_refund_id: string; stripe_charge_id: string; connected_account_id: string; fee: number; rec: number; sources: Source[] }>
  let recoveredTotal = 0
  let owed = 0
  for (const r of rows) {
    const need = r.fee - r.rec
    if (need <= 0) continue
    const charge = await stripe.charges.retrieve(r.stripe_charge_id)
    const ownTransferId = idOf(charge.transfer)
    const attempt = (r.sources?.length ?? 0) + 1
    const got = await collect(stripe, r.connected_account_id, need, r.stripe_refund_id, orderReference, ownTransferId,
      { manual: true, by: actorEmail, keySuffix: `:manual${attempt}:${Date.now()}` })
    const moved = got.reduce((t, s) => t + s.amount, 0)
    recoveredTotal += moved
    owed += need - moved
    if (moved > 0) {
      const all = [...(r.sources ?? []), ...got]
      await sql`
        UPDATE disco_refund_stripe_fees
           SET recovered_amount = recovered_amount + ${moved / 100}, sources = ${JSON.stringify(all)}::jsonb,
               status = ${need - moved > 0 ? 'uncollected' : 'recovered'}, updated_at = NOW()
         WHERE id = ${r.id}
      `
    }
  }
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    VALUES (${orderReference}::uuid, 'REFUND_STRIPE_FEE_RECOVERY_ATTEMPT',
            ${JSON.stringify({ by: actorEmail, recovered: recoveredTotal / 100, stillOwed: owed / 100 })}::jsonb, 'ADMIN_RECOVER_STRIPE_FEE')
  `.catch(() => {})
  return { recoveredCents: recoveredTotal, stillOwedCents: owed }
}

/** Per-order totals for display: what the restaurant paid back, and what Disco is still covering. */
export async function refundStripeFeeTotals(orderReference: string): Promise<{ recovered: number; uncollected: number }> {
  const r = (await sql`
    SELECT COALESCE(SUM(recovered_amount), 0) AS rec, COALESCE(SUM(fee_amount - recovered_amount), 0) AS owed
      FROM disco_refund_stripe_fees WHERE order_reference = ${orderReference}
  `.catch(() => [])) as { rec: string; owed: string }[]
  return { recovered: Number(r[0]?.rec) || 0, uncollected: Number(r[0]?.owed) || 0 }
}
