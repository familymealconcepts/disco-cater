// THE RESTAURANT BEARS STRIPE'S ACTUAL FEE (Peter, 29 Oct 2026 — decision 3).
//
// Checkout computes the restaurant's transfer with an ESTIMATED Stripe fee
// (2.9% + $0.30, lib/promo-pricing.ts) because the real fee is only known after
// the charge: an Amex or international card costs more (#900000456: $14.20
// estimated, $21.38 actual), a bank-debit invoice costs less. Until now Disco
// absorbed the difference. Checkout and charge creation are not to change, so
// the difference is settled AFTERWARDS, once per charge, when Stripe reports the
// fee:
//
//   delta = actual fee − estimate the transfer was computed with
//   delta > 0 → reversed from THIS charge's payout transfer (bounded by what is
//               left on it and by the restaurant's Stripe balance); anything that
//               cannot be taken is recorded 'uncollected' and ops is alerted
//   delta < 0 → paid to the restaurant by a transfer funded by this charge
//
// If part of the charge was already refunded when this runs, only the KEPT share
// is settled: (1 − refunded/captured) × delta. The refunded share's fee was
// already taken by lib/order/refund-stripe-fee.ts, which works from the actual
// fee. After a true-up, later refunds take their fee share on the ESTIMATE
// (the transfer they reverse was computed with it) — refundFeeBasisCents() —
// so the restaurant bears exactly the actual fee in every order of events.
//
// OFF UNTIL PETER SWITCHES IT ON. Runs only with STRIPE_FEE_TRUEUP_ENABLED=1, and
// only for charges created at or after STRIPE_FEE_TRUEUP_SINCE (ISO time) —
// "future orders only". Disco-processed orders only; never FamilyMeal-copied.
//
// WHICH ESTIMATE. The estimate behind each charge comes from the order's
// breakdown rows (disco_sale_transactions), the same figures the transfer was
// computed from:
//   checkout charge or checkout invoice → the ORIGINAL row's stripe_fee;
//   an edit's card charge               → its MANUAL_EDIT row's stripe_fee minus
//                                         the breakdown before it (the edit's
//                                         transfer is new payout − old payout).
// Anything else (reissued invoices, edit invoices, withheld payouts) is recorded
// 'skipped' with the reason, never guessed.
import type Stripe from 'stripe'
import { sql } from '../db'
import { alertOps } from '../ops-alert'
import { orderLink } from '../ops-alert-format'

export const TRUEUP_KIND = 'stripe_fee_trueup'
const money = (c: number) => `$${(c / 100).toFixed(2)}`
const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null)

export function trueupEnabled(): { on: boolean; since: Date | null } {
  const since = process.env.STRIPE_FEE_TRUEUP_SINCE ? new Date(process.env.STRIPE_FEE_TRUEUP_SINCE) : null
  const on = process.env.STRIPE_FEE_TRUEUP_ENABLED === '1' && !!since && !Number.isNaN(since.getTime())
  return { on, since: on ? since : null }
}

/** What to settle, in cents: the kept share of (actual − estimate). Positive = restaurant owes. */
export function trueupDelta(actualFee: number, estimatedFee: number, capturedCents: number, refundedCents: number): number {
  if (capturedCents <= 0) return 0
  const kept = Math.max(0, capturedCents - refundedCents) / capturedCents
  return Math.round((actualFee - estimatedFee) * kept)
}

async function headroomCents(stripe: Stripe, acct: string): Promise<number> {
  const b = await stripe.balance.retrieve({}, { stripeAccount: acct })
  const sum = (l: Array<{ amount: number; currency: string }> | undefined) => (l ?? []).filter(x => x.currency === 'usd').reduce((t, x) => t + x.amount, 0)
  return Math.max(0, sum(b.available) + sum(b.pending))
}

export interface SettleResult { settledCents: number; uncollectedCents: number; moveId: string | null; how: 'reversal' | 'topup' | 'none' }

/**
 * The Stripe half: move `deltaCents` between the restaurant and Disco for one
 * charge. Positive → reverse from the payout transfer; negative → pay the
 * restaurant from this charge. Idempotent on the charge id. No database writes,
 * so it can be exercised alone in test mode.
 */
export async function settleFeeDifference(stripe: Stripe, i: {
  chargeId: string; orderReference: string; payoutTransferId: string; deltaCents: number
}): Promise<SettleResult> {
  if (i.deltaCents === 0) return { settledCents: 0, uncollectedCents: 0, moveId: null, how: 'none' }
  const t = await stripe.transfers.retrieve(i.payoutTransferId)
  const acct = idOf(t.destination)
  if (!acct) throw new Error(`transfer ${t.id} has no destination`)
  const metadata = { kind: TRUEUP_KIND, orderReference: i.orderReference, chargeId: i.chargeId }
  if (i.deltaCents < 0) {
    const tr = await stripe.transfers.create({
      // No transfer_group: Stripe refuses one when the charge already has its own
      // (every destination charge does), and files this under the charge's group.
      // The facts sync finds it there and in the STRIPE_FEE_TRUEUP event.
      amount: -i.deltaCents, currency: 'usd', destination: acct, source_transaction: i.chargeId,
      description: `Stripe fee below estimate on ${i.chargeId}`, metadata,
    }, { idempotencyKey: `fee-trueup:${i.chargeId}` })
    return { settledCents: -i.deltaCents, uncollectedCents: 0, moveId: tr.id, how: 'topup' }
  }
  const left = t.amount - (t.amount_reversed ?? 0)
  const room = await headroomCents(stripe, acct).catch(() => 0)
  const take = Math.min(i.deltaCents, left, room)
  if (take <= 0) return { settledCents: 0, uncollectedCents: i.deltaCents, moveId: null, how: 'reversal' }
  const rev = await stripe.transfers.createReversal(t.id, {
    amount: take, description: `Stripe fee above estimate on ${i.chargeId}`, metadata,
  }, { idempotencyKey: `fee-trueup:${i.chargeId}` })
  return { settledCents: take, uncollectedCents: i.deltaCents - take, moveId: rev.id, how: 'reversal' }
}

interface Candidate {
  order_reference: string; order_number: string; restaurant_name: string | null
  payment_intent_id: string; transfer_id: string | null
}

/** Successful Disco payments created since the cutover and not yet settled. */
async function candidates(since: Date, limit: number): Promise<Candidate[]> {
  return (await sql`
    SELECT sp.order_reference::text AS order_reference, o.order_number::text AS order_number, o.restaurant_name,
           sp.stripe_payment_intent_id AS payment_intent_id, sp.stripe_transfer_id AS transfer_id
      FROM disco_stripe_payments sp
      JOIN disco_orders o ON o.reference = sp.order_reference
     WHERE sp.status = 'SUCCEEDED' AND sp.stripe_payment_intent_id LIKE 'pi_%'
       AND o.fm_order_reference IS NULL
       AND sp.created_at >= ${since.toISOString()}::timestamptz
       AND sp.created_at < NOW() - INTERVAL '10 minutes'
       AND NOT EXISTS (SELECT 1 FROM disco_stripe_fee_trueups x
                        WHERE x.detail->>'paymentIntentId' = sp.stripe_payment_intent_id)
     ORDER BY sp.created_at
     LIMIT ${limit}
  `) as Candidate[]
}

/** The fee estimate this charge's transfer was computed with, in cents — or why it is not known. */
async function estimateFor(orderReference: string, paymentIntentId: string, invoiceId: string | null): Promise<{ cents: number } | { reason: string }> {
  const rows = (await sql`
    SELECT t.transaction_type, t.source, t.stripe_payment_intent_id, t.stripe_invoice_id, t.stripe_fee, t.created_at
      FROM disco_sale_transactions t JOIN disco_orders o ON o.id = t.order_id
     WHERE o.reference = ${orderReference}::uuid
       AND (t.transaction_type = 'ORIGINAL'
            OR (t.source = 'MANUAL_EDIT' AND t.transaction_type IN ('ADDITIONAL', 'REFUND') AND t.state_tax IS NOT NULL))
     ORDER BY t.created_at, t.id
  `) as Array<{ transaction_type: string; source: string | null; stripe_payment_intent_id: string | null; stripe_invoice_id: string | null; stripe_fee: string | null }>
  const at = rows.findIndex(r => r.stripe_payment_intent_id === paymentIntentId || (invoiceId && r.stripe_invoice_id === invoiceId))
  if (at < 0) return { reason: 'no breakdown row for this payment' }
  const row = rows[at]
  if (row.stripe_fee == null) return { reason: 'breakdown row has no Stripe fee estimate' }
  const fee = Math.round(Number(row.stripe_fee) * 100)
  if (row.transaction_type === 'ORIGINAL') return { cents: fee }
  if (row.transaction_type === 'ADDITIONAL' && !invoiceId && at > 0 && rows[at - 1].stripe_fee != null) {
    return { cents: fee - Math.round(Number(rows[at - 1].stripe_fee) * 100) }
  }
  return { reason: `${row.transaction_type} edit row — estimate not derivable` }
}

async function record(c: Candidate, chargeId: string, status: string, f: {
  transfer?: string | null; est?: number | null; actual?: number | null; delta?: number | null; settled?: number; reason?: string | null; detail?: Record<string, unknown>
}) {
  const claimed = (await sql`
    INSERT INTO disco_stripe_fee_trueups
      (stripe_charge_id, order_reference, payout_transfer_id, estimated_fee, actual_fee, delta, settled_amount, status, reason, detail)
    VALUES (${chargeId}, ${c.order_reference}, ${f.transfer ?? null},
            ${f.est != null ? f.est / 100 : null}, ${f.actual != null ? f.actual / 100 : null}, ${f.delta != null ? f.delta / 100 : null},
            ${(f.settled ?? 0) / 100}, ${status}, ${f.reason ?? null},
            ${JSON.stringify({ paymentIntentId: c.payment_intent_id, ...(f.detail ?? {}) })}::jsonb)
    ON CONFLICT (stripe_charge_id) DO NOTHING
    RETURNING id
  `) as { id: number }[]
  return claimed[0]?.id ?? null
}

/**
 * Settle the Stripe-fee difference on up to `limit` new payments. Never throws per
 * payment: each outcome is recorded, and a shortfall or failure alerts ops.
 */
export async function runFeeTrueups(stripe: Stripe, limit = 25): Promise<{ enabled: boolean; checked: number; outcomes: Record<string, number> }> {
  const { on, since } = trueupEnabled()
  const outcomes: Record<string, number> = {}
  if (!on || !since) return { enabled: false, checked: 0, outcomes }
  const list = await candidates(since, limit)
  for (const c of list) {
    let outcome = 'failed'
    try {
      const pi = await stripe.paymentIntents.retrieve(c.payment_intent_id)
      const chargeId = idOf(pi.latest_charge)
      if (!chargeId) { outcome = 'waiting'; continue }
      const ch = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction', 'invoice'] })
      const bt = ch.balance_transaction as Stripe.BalanceTransaction | string | null
      if (!bt || typeof bt !== 'object') { outcome = 'waiting'; continue }   // fee not reported yet; next run
      const inv = (ch as unknown as { invoice?: Stripe.Invoice | string | null }).invoice
      const invoiceId = idOf(inv)
      const invoiceKind = inv && typeof inv === 'object' ? inv.metadata?.kind ?? null : null
      const payoutTransferId = idOf(ch.transfer) ?? c.transfer_id
      // Only checkout invoices: a reissue's transfer is the whole new order, an
      // edit invoice's a payout delta — neither matches a single breakdown row.
      if (invoiceId && invoiceKind !== 'native_order_invoice') {
        outcome = 'skipped'
        await record(c, chargeId, 'skipped', { transfer: payoutTransferId, actual: bt.fee, reason: `invoice kind ${invoiceKind ?? 'unknown'} — not settled automatically` })
        continue
      }
      if (!payoutTransferId) {
        outcome = 'skipped'
        await record(c, chargeId, 'skipped', { actual: bt.fee, reason: 'no payout transfer (payouts withheld or not yet sent)' })
        continue
      }
      const est = await estimateFor(c.order_reference, c.payment_intent_id, invoiceId)
      if ('reason' in est) {
        outcome = 'skipped'
        await record(c, chargeId, 'skipped', { transfer: payoutTransferId, actual: bt.fee, reason: est.reason })
        continue
      }
      const captured = ch.amount_captured ?? ch.amount
      const delta = trueupDelta(bt.fee, est.cents, captured, ch.amount_refunded ?? 0)
      if (delta === 0) {
        outcome = 'no_difference'
        await record(c, chargeId, 'no_difference', { transfer: payoutTransferId, est: est.cents, actual: bt.fee, delta: 0 })
        continue
      }
      // Claim first, so a retry or a second run never moves money twice
      // (the Stripe call is idempotent on the charge as well).
      const id = await record(c, chargeId, 'pending', {
        transfer: payoutTransferId, est: est.cents, actual: bt.fee, delta,
        detail: { capturedCents: captured, refundedCentsAtSettle: ch.amount_refunded ?? 0 },
      })
      if (!id) { outcome = 'already_claimed'; continue }
      const r = await settleFeeDifference(stripe, { chargeId, orderReference: c.order_reference, payoutTransferId, deltaCents: delta })
      outcome = r.uncollectedCents > 0 ? 'uncollected' : 'settled'
      await sql`
        UPDATE disco_stripe_fee_trueups
           SET settled_amount = ${r.settledCents / 100}, status = ${outcome},
               reason = ${r.uncollectedCents > 0 ? `${money(r.uncollectedCents)} not collected — no room on the payout or balance` : null},
               detail = detail || ${JSON.stringify({ how: r.how, moveId: r.moveId, uncollectedCents: r.uncollectedCents })}::jsonb,
               updated_at = NOW()
         WHERE id = ${id}
      `
      await sql`
        INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
        VALUES (${c.order_reference}::uuid, 'STRIPE_FEE_TRUEUP',
                ${JSON.stringify({ chargeId, estimated: est.cents / 100, actual: bt.fee / 100, delta: delta / 100, settled: r.settledCents / 100, how: r.how, moveId: r.moveId })}::jsonb,
                'STRIPE_FEE_TRUEUP')
      `.catch(e => console.error('[fee-trueup] event (non-fatal):', e instanceof Error ? e.message : e))
      if (r.uncollectedCents > 0) {
        await alertOps({
          severity: 'warn',
          headline: `Stripe fee difference not collected — order #${c.order_number}`,
          lines: [`${c.restaurant_name ?? 'The restaurant'} · order #${c.order_number}`,
            `Stripe's fee was ${money(bt.fee)} against an estimate of ${money(est.cents)}; ${money(r.uncollectedCents)} of the ${money(delta)} difference could not be taken from the restaurant's payout or balance, so Disco is covering it.`],
          action: 'nothing is retried automatically; decide whether to recover it.',
          link: orderLink(c.order_reference, c.order_number),
          context: { orderReference: c.order_reference, chargeId, uncollected: r.uncollectedCents / 100 },
        }).catch(() => {})
      }
    } catch (e) {
      console.error('[fee-trueup] failed (nothing recorded as settled):', c.order_reference, e instanceof Error ? e.message : e)
      await sql`
        UPDATE disco_stripe_fee_trueups SET status = 'failed', reason = ${String(e instanceof Error ? e.message : e).slice(0, 300)}, updated_at = NOW()
         WHERE detail->>'paymentIntentId' = ${c.payment_intent_id} AND status = 'pending'
      `.catch(() => {})
    } finally {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    }
  }
  return { enabled: true, checked: list.length, outcomes }
}

/**
 * The fee a refund's share is taken on, in cents (lib/order/refund-stripe-fee.ts).
 * Normally Stripe's actual fee. Once a true-up has settled the charge, the
 * restaurant has already paid the difference in full, and the transfer a refund
 * reverses was computed with the estimate — so the refund's share is of the
 * estimate. Without this the restaurant would pay the difference twice.
 */
export async function refundFeeBasisCents(chargeId: string, actualFeeCents: number): Promise<number> {
  const r = (await sql`
    SELECT estimated_fee, detail FROM disco_stripe_fee_trueups
     WHERE stripe_charge_id = ${chargeId} AND status IN ('settled', 'uncollected') LIMIT 1
  `.catch(() => [])) as Array<{ estimated_fee: string | null; detail: { capturedCents?: number; refundedCentsAtSettle?: number } }>
  if (!r[0] || r[0].estimated_fee == null) return actualFeeCents
  return Math.round(Number(r[0].estimated_fee) * 100)
}
