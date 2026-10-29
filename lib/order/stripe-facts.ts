// WHAT STRIPE ACTUALLY DID WITH AN ORDER'S MONEY (Peter, 29 Oct 2026).
//
// Reports used to show Disco's INTENT: the payout the checkout computed, the
// Stripe fee it estimated (2.9% + $0.30), and a refund's reversal worked out as
// refund ÷ charge × payout. The audit that day compared 1,006 orders against live
// Stripe and found the intent wrong wherever reality diverged — a paid reissued
// invoice whose payout never moved (#900000303, #900000663), refunds made in the
// Stripe dashboard that reversed nothing (#900000419, #900000288), and every
// Amex/international card, whose real fee is higher than the estimate
// (#900000456: $14.20 estimated, $21.38 actual).
//
// Decision 4: reports show what Stripe actually transferred and reversed.
// Decision 3: and Stripe's actual fee.
//
// Scheduled reports and exports read Neon, so this copies Stripe's facts for each
// DISCO-PROCESSED order into disco_order_stripe_facts (migration 011), refreshed
// by Stripe's webhook (below). Read-only against Stripe. FamilyMeal-copied orders are never synced — Peter: nothing
// involving FamilyMeal-copied orders.
//
// Where the money is found (each verified in the audit):
//   charges   — every PaymentIntent on disco_stripe_payments, the sale
//               transactions and order edits, plus every invoice the order ever
//               had (current, pending, edits', and reissued ones named in its
//               events) and that invoice's charge;
//   transfers — the destination transfer on each charge, every transfer in the
//               order's transfer group (invoice and edit payouts), the recorded
//               stripe_transfer_id, and any transfer named in the order's events
//               (e.g. a courier tip paid to the restaurant);
//   reversals — all reversals of those transfers EXCEPT refund-fee recoveries
//               (kind 'refund_stripe_fee'): those can sit on another order's
//               transfer and are attributed by disco_refund_stripe_fees instead,
//               which the report already subtracts as "Stripe Fee on Refund".
import type Stripe from 'stripe'
import { sql } from '../db'

export const REFUND_FEE_KIND = 'refund_stripe_fee'

export interface OrderStripeFacts {
  captured: number      // cents
  refunded: number
  stripeFee: number
  feeKnown: boolean
  transferred: number
  reversed: number
  invoiceStatus: string | null
  detail: { charges: string[]; transfers: string[]; invoices: string[] }
}

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null)
const IN_RE = /\bin_[A-Za-z0-9]{10,}/g
const TR_RE = /\btr_[A-Za-z0-9]{10,}/g

interface OrderLinks {
  reference: string
  stripe_invoice_id: string | null
  pending_stripe_invoice_id: string | null
  sp_pis: string[] | null
  sp_trs: string[] | null
  st_pis: string[] | null
  st_invs: string[] | null
  ed_pis: string[] | null
  ed_invs: string[] | null
  ev_text: string | null
}

async function loadLinks(orderReference: string): Promise<OrderLinks | null> {
  const r = (await sql`
    SELECT o.reference::text AS reference, o.stripe_invoice_id, o.pending_stripe_invoice_id,
           (SELECT array_agg(DISTINCT sp.stripe_payment_intent_id) FROM disco_stripe_payments sp
              WHERE sp.order_reference = o.reference AND sp.stripe_payment_intent_id LIKE 'pi_%') AS sp_pis,
           (SELECT array_agg(DISTINCT sp.stripe_transfer_id) FROM disco_stripe_payments sp
              WHERE sp.order_reference = o.reference AND sp.stripe_transfer_id IS NOT NULL) AS sp_trs,
           (SELECT array_agg(DISTINCT t.stripe_payment_intent_id) FROM disco_sale_transactions t
              WHERE t.order_id = o.id AND t.stripe_payment_intent_id LIKE 'pi_%') AS st_pis,
           (SELECT array_agg(DISTINCT t.stripe_invoice_id) FROM disco_sale_transactions t
              WHERE t.order_id = o.id AND t.stripe_invoice_id LIKE 'in_%') AS st_invs,
           (SELECT array_agg(DISTINCT e.stripe_payment_intent_id) FROM disco_order_edits e
              WHERE e.fm_order_reference = o.reference AND e.stripe_payment_intent_id LIKE 'pi_%') AS ed_pis,
           (SELECT array_agg(DISTINCT e.stripe_invoice_id) FROM disco_order_edits e
              WHERE e.fm_order_reference = o.reference AND e.stripe_invoice_id LIKE 'in_%') AS ed_invs,
           (SELECT string_agg(e.event_data::text, ' ') FROM disco_order_events e WHERE e.order_reference = o.reference) AS ev_text
      FROM disco_orders o
     WHERE o.reference = ${orderReference}::uuid AND o.fm_order_reference IS NULL
     LIMIT 1
  `) as OrderLinks[]
  return r[0] ?? null
}

/** Read Stripe's facts for one Disco-processed order. Read-only. */
export async function collectOrderStripeFacts(stripe: Stripe, orderReference: string): Promise<OrderStripeFacts | null> {
  const o = await loadLinks(orderReference)
  if (!o) return null
  const ev = o.ev_text ?? ''
  const piIds = new Set<string>([...(o.sp_pis ?? []), ...(o.st_pis ?? []), ...(o.ed_pis ?? [])].filter(Boolean))
  const invIds = new Set<string>([o.stripe_invoice_id, o.pending_stripe_invoice_id, ...(o.st_invs ?? []), ...(o.ed_invs ?? [])]
    .filter((x): x is string => !!x && x.startsWith('in_')))
  for (const m of ev.matchAll(IN_RE)) invIds.add(m[0])
  const trIds = new Set<string>((o.sp_trs ?? []).filter(Boolean))
  for (const m of ev.matchAll(TR_RE)) trIds.add(m[0])

  const chargeIds = new Set<string>()
  let invoiceStatus: string | null = null
  let newestInvoice = -1
  for (const id of invIds) {
    const iv = await stripe.invoices.retrieve(id).catch(() => null)
    if (!iv) continue
    if (iv.created > newestInvoice) { newestInvoice = iv.created; invoiceStatus = iv.status ?? null }
    const c = idOf((iv as unknown as { charge?: unknown }).charge); if (c) chargeIds.add(c)
    const p = idOf((iv as unknown as { payment_intent?: unknown }).payment_intent); if (p) piIds.add(p)
  }
  for (const id of piIds) {
    const pi = await stripe.paymentIntents.retrieve(id).catch(() => null)
    if (pi?.status === 'succeeded') { const c = idOf(pi.latest_charge); if (c) chargeIds.add(c) }
  }

  let captured = 0, refunded = 0, stripeFee = 0, feeKnown = true
  const chargeGroups = new Set<string>()
  for (const id of chargeIds) {
    const ch = await stripe.charges.retrieve(id, { expand: ['balance_transaction'] })
    if (!ch.paid || !ch.captured) continue
    captured += ch.amount_captured ?? ch.amount
    refunded += ch.amount_refunded ?? 0
    const bt = ch.balance_transaction as Stripe.BalanceTransaction | string | null
    if (bt && typeof bt === 'object') stripeFee += bt.fee
    else feeKnown = false
    const tr = idOf(ch.transfer); if (tr) trIds.add(tr)
    if (ch.transfer_group) chargeGroups.add(ch.transfer_group)
  }
  // A transfer funded by a charge lands in the CHARGE's transfer group (e.g. a
  // fee true-up top-up), which is not the order's.
  for (const g of chargeGroups) {
    if (g === orderReference) continue
    const l = await stripe.transfers.list({ transfer_group: g, limit: 100 }).catch(() => null)
    for (const t of l?.data ?? []) trIds.add(t.id)
  }
  const group = await stripe.transfers.list({ transfer_group: orderReference, limit: 100 }).catch(() => null)
  for (const t of group?.data ?? []) trIds.add(t.id)

  let transferred = 0, reversed = 0
  for (const id of trIds) {
    const t = await stripe.transfers.retrieve(id).catch(() => null)
    if (!t) continue
    transferred += t.amount
    const revs = t.reversals?.has_more
      ? (await stripe.transfers.listReversals(id, { limit: 100 })).data
      : (t.reversals?.data ?? [])
    reversed += revs.filter(r => r.metadata?.kind !== REFUND_FEE_KIND).reduce((a, r) => a + r.amount, 0)
  }
  return {
    captured, refunded, stripeFee, feeKnown, transferred, reversed, invoiceStatus,
    detail: { charges: [...chargeIds], transfers: [...trIds], invoices: [...invIds] },
  }
}

/** Collect and store one order's facts. Returns false when the order is not Disco-processed. */
export async function syncOrderStripeFacts(stripe: Stripe, orderReference: string): Promise<boolean> {
  const f = await collectOrderStripeFacts(stripe, orderReference)
  if (!f) return false
  await sql`
    INSERT INTO disco_order_stripe_facts
      (order_reference, captured, refunded, stripe_fee, fee_known, transferred, reversed, invoice_status, detail, synced_at)
    VALUES (${orderReference}, ${f.captured / 100}, ${f.refunded / 100}, ${f.stripeFee / 100}, ${f.feeKnown},
            ${f.transferred / 100}, ${f.reversed / 100}, ${f.invoiceStatus}, ${JSON.stringify(f.detail)}::jsonb, NOW())
    ON CONFLICT (order_reference) DO UPDATE SET
      captured = EXCLUDED.captured, refunded = EXCLUDED.refunded, stripe_fee = EXCLUDED.stripe_fee,
      fee_known = EXCLUDED.fee_known, transferred = EXCLUDED.transferred, reversed = EXCLUDED.reversed,
      invoice_status = EXCLUDED.invoice_status, detail = EXCLUDED.detail, synced_at = NOW()
  `
  return true
}

// ── WHEN THE FACTS ARE REFRESHED (Peter, 2026-10-29) ─────────────────────────
// From Stripe's webhook, never on a schedule: each event that can change an
// order's money refreshes that order (refreshStripeFactsForEvent, called by
// app/api/stripe/webhook/route.ts). Existing orders were filled once by
// scripts/backfill-stripe-facts.ts.
//
// Events and what they change:
//   payment_intent.succeeded           a charge (and, usually, its fee)
//   charge.refunded                    a refund — made anywhere, Stripe dashboard included
//   charge.updated                     the fee, when Stripe attaches it after the charge
//   invoice.paid / payment_succeeded   an invoice payment and its payout
//   transfer.reversed                  a payout taken back
// FamilyMeal's payments reach the same endpoint (one platform account) and
// match no Disco-processed order, so they are skipped.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function ordersForPaymentIntent(pi: string): Promise<string[]> {
  const r = (await sql`
    SELECT DISTINCT o.reference::text AS ref FROM disco_orders o
     WHERE o.fm_order_reference IS NULL AND (
           EXISTS (SELECT 1 FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.stripe_payment_intent_id = ${pi})
        OR EXISTS (SELECT 1 FROM disco_sale_transactions t WHERE t.order_id = o.id AND t.stripe_payment_intent_id = ${pi})
        OR EXISTS (SELECT 1 FROM disco_order_edits e WHERE e.fm_order_reference = o.reference AND e.stripe_payment_intent_id = ${pi}))
  `) as { ref: string }[]
  return r.map(x => x.ref)
}

async function ordersForInvoice(inv: string): Promise<string[]> {
  const r = (await sql`
    SELECT DISTINCT o.reference::text AS ref FROM disco_orders o
     WHERE o.fm_order_reference IS NULL AND (
           o.stripe_invoice_id = ${inv} OR o.pending_stripe_invoice_id = ${inv}
        OR EXISTS (SELECT 1 FROM disco_sale_transactions t WHERE t.order_id = o.id AND t.stripe_invoice_id = ${inv})
        OR EXISTS (SELECT 1 FROM disco_order_edits e WHERE e.fm_order_reference = o.reference AND e.stripe_invoice_id = ${inv}))
  `) as { ref: string }[]
  return r.map(x => x.ref)
}

async function discoOrderExists(ref: string): Promise<boolean> {
  if (!UUID_RE.test(ref)) return false
  const r = (await sql`SELECT 1 FROM disco_orders WHERE reference = ${ref}::uuid AND fm_order_reference IS NULL LIMIT 1`) as unknown[]
  return r.length > 0
}

/** The Disco-processed orders a Stripe event's money belongs to. Empty for anything else. */
export async function ordersForStripeEvent(stripe: Stripe, event: Stripe.Event): Promise<string[]> {
  const out = new Set<string>()
  const obj = event.data.object as unknown as Record<string, unknown>
  const metaRef = String((obj.metadata as Record<string, string> | undefined)?.orderReference ?? '')
  if (metaRef && await discoOrderExists(metaRef)) out.add(metaRef.toLowerCase())
  switch (event.type) {
    case 'payment_intent.succeeded':
      for (const r of await ordersForPaymentIntent(String(obj.id))) out.add(r)
      break
    case 'charge.refunded':
    case 'charge.updated': {
      const pi = idOf(obj.payment_intent)
      if (pi) for (const r of await ordersForPaymentIntent(pi)) out.add(r)
      const inv = idOf(obj.invoice)
      if (inv) for (const r of await ordersForInvoice(inv)) out.add(r)
      break
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      for (const r of await ordersForInvoice(String(obj.id))) out.add(r)
      break
    case 'transfer.reversed': {
      const { resolveTransferOrder } = await import('./transfer-reversals')
      const direct = await resolveTransferOrder(String(obj.id), (obj.transfer_group as string | null) ?? null)
      if (direct && await discoOrderExists(direct)) out.add(direct)
      // A checkout payout's id is not stored: find it through the charge that funded it.
      const src = idOf(obj.source_transaction)
      if (src?.startsWith('ch_')) {
        const ch = await stripe.charges.retrieve(src).catch(() => null)
        const pi = idOf(ch?.payment_intent)
        if (pi) for (const r of await ordersForPaymentIntent(pi)) out.add(r)
      }
      // A reversal made for another order (a refund's fee) is that order's too.
      const revs = ((obj.reversals as { data?: Array<{ metadata?: Record<string, string> }> } | undefined)?.data) ?? []
      for (const rv of revs) {
        const ref = rv.metadata?.orderReference
        if (ref && await discoOrderExists(ref)) out.add(ref.toLowerCase())
      }
      break
    }
  }
  return [...out]
}

export const STRIPE_FACTS_EVENTS = new Set([
  'payment_intent.succeeded', 'charge.refunded', 'charge.updated',
  'invoice.paid', 'invoice.payment_succeeded', 'transfer.reversed',
])

/** Webhook entry point. Refreshes every order the event touches. Never throws. */
export async function refreshStripeFactsForEvent(stripe: Stripe, event: Stripe.Event): Promise<void> {
  if (!STRIPE_FACTS_EVENTS.has(event.type)) return
  try {
    for (const ref of await ordersForStripeEvent(stripe, event)) {
      await syncOrderStripeFacts(stripe, ref).catch(e =>
        console.error('[stripe-facts] refresh failed (non-fatal):', ref, event.type, e instanceof Error ? e.message : e))
    }
  } catch (e) {
    console.error('[stripe-facts] could not resolve the order for', event.type, event.id, '(non-fatal):', e instanceof Error ? e.message : e)
  }
}

// ── PAYMENT STATUS, IN WORDS (decision 1) ────────────────────────────────────
// Unpaid orders stay in reports and dashboards, labelled so nobody mistakes them
// for paid ones. Disco-processed orders only; a FamilyMeal-copied row keeps FM's
// own status and gets no label.
export type PaymentLabel =
  | 'Paid' | 'Refunded' | 'Partially refunded'
  | 'Unpaid invoice' | 'Abandoned checkout' | 'Voided' | 'Declined' | 'Not paid'

export function paymentLabel(i: {
  orderStatus: string
  /** Stripe facts in cents, or null before the order's first sync. */
  captured: number | null
  refunded: number | null
  invoiceStatus: string | null
  /** Disco's own record of a successful payment — used until Stripe facts exist. */
  paidInDisco: boolean
  refundInDisco: number
  totalInDisco: number
}): PaymentLabel {
  const captured = i.captured ?? (i.paidInDisco ? Math.round(i.totalInDisco * 100) : 0)
  const refunded = i.captured != null ? (i.refunded ?? 0) : Math.round(i.refundInDisco * 100)
  if (captured > 0) {
    if (refunded >= captured) return 'Refunded'
    return refunded > 0 ? 'Partially refunded' : 'Paid'
  }
  const s = (i.orderStatus || '').toUpperCase()
  // A $0 invoice, or one marked paid outside Stripe: paid, with nothing captured.
  if (i.invoiceStatus === 'paid') return 'Paid'
  if (i.invoiceStatus === 'void' || s === 'VOID' || s === 'VOIDED') return 'Voided'
  if (i.invoiceStatus === 'open' || i.invoiceStatus === 'draft' || s === 'UNPAID') return 'Unpaid invoice'
  if (s === 'PAYMENT_FAILED') return 'Declined'
  if (s === 'RESERVED' || s === 'EXPIRED' || s === 'RESERVED_EXPIRED') return 'Abandoned checkout'
  return 'Not paid'
}

export const PAID_LABELS: ReadonlySet<PaymentLabel> = new Set(['Paid', 'Refunded', 'Partially refunded'])
