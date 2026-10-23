// The #ops-alerts wording for money that went wrong on an order: restaurant not
// paid, refunds refused or half-done, order-edit invoices, a charge for a
// sold-out item, Stripe and Disco disagreeing. Approved word for word by Kevin,
// 2026-10-23. Every one names the order and restaurant, says what happened in
// words, says what to do, and links the order in NM OS — and none carries JSON.
import { sql } from '../db'
import { alertOps, alertOnce, openAlertKeys, resolveAlert, type OpsAlert } from '../ops-alert'
import { money, orderLink, shortError } from '../ops-alert-format'
import { orderFacts, orderLine, type OrderFacts } from '../ops-alert-facts'

/** Stripe's error, said in words where it has a known shape. */
export function stripeSaid(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  const over = /must not exceed the source amount of (\$\d[\d,]*(?:\.\d{2})?)/i.exec(msg)
  if (over) return `Stripe said the transfer was larger than the payment (${over[1]}).`
  if (/insufficient funds|does not have sufficient funds/i.test(msg)) return "Stripe said the restaurant's balance was too low."
  return `Stripe said: "${shortError(msg)}"`
}

async function facts(ref: string): Promise<{ f: OrderFacts | null; n: string }> {
  const f = await orderFacts(ref)
  return { f, n: f?.orderNumber ? `#${f.orderNumber}` : ref }
}

function withOrder(f: OrderFacts | null, ref: string, a: Omit<OpsAlert, 'link'>): OpsAlert {
  return { ...a, link: orderLink(f?.reference ?? ref, f?.orderNumber) }
}

// ── Restaurant not paid ───────────────────────────────────────────────────────
// Keyed per order; closed by resolveRestaurantNotPaid() on the hourly
// reconcile-native-payments run once a transfer is recorded for the order, or
// the order is refunded or cancelled.

export async function alertRestaurantNotPaid(ref: string, info: { paid: number | null; error: unknown; invoiceId: string; edit?: boolean }): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOnce(`unpaid:${ref.toLowerCase()}`, withOrder(f, ref, {
    severity: 'urgent',
    headline: `Restaurant not paid — order ${n}`,
    lines: [
      orderLine(f, { when: null, amount: info.paid ?? f?.total ?? null, amountLabel: info.edit ? 'edit invoice paid' : 'invoice paid' }),
      `The diner paid, but the transfer to the restaurant failed. ${stripeSaid(info.error)}`,
    ],
    action: 'pay the restaurant by hand in Stripe, or correct the amount and retry.',
    context: { ref, invoiceId: info.invoiceId, edit: !!info.edit, error: info.error instanceof Error ? info.error.message : String(info.error) },
  }))
}

export async function resolveRestaurantNotPaid(): Promise<void> {
  const keys = await openAlertKeys('unpaid:')
  const refs = keys.map(k => k.slice('unpaid:'.length))
  if (!refs.length) return
  const rows = (await sql`
    SELECT o.reference::text AS reference, o.order_status,
           EXISTS (SELECT 1 FROM disco_stripe_payments p
                    WHERE p.order_reference = o.reference AND p.stripe_transfer_id IS NOT NULL) AS paid_out
      FROM disco_orders o WHERE o.reference::text = ANY(${refs})
  `.catch(() => [])) as Array<{ reference: string; order_status: string | null; paid_out: boolean }>
  for (const r of rows) {
    const s = String(r.order_status ?? '').toUpperCase()
    const text = r.paid_out ? 'Resolved: a payout to the restaurant is now recorded.'
      : (s === 'REFUND' || s === 'PARTIAL_REFUND') ? 'Resolved: the order was refunded.'
      : (s === 'CANCELED' || s === 'CANCELLED' || s === 'VOIDED') ? 'Resolved: the order was cancelled.'
      : null
    if (text) await resolveAlert(`unpaid:${r.reference.toLowerCase()}`, text)
  }
}

export async function alertPaidOnClosedOrder(ref: string, invoiceId: string): Promise<void> {
  const { f, n } = await facts(ref)
  const status = f?.status ? f.status.toUpperCase() : 'no longer unpaid'
  await alertOnce(`paid-closed:${ref.toLowerCase()}`, withOrder(f, ref, {
    severity: 'urgent',
    headline: `Diner paid an invoice on a ${status === 'CANCELED' || status === 'CANCELLED' ? 'cancelled' : 'closed'} order — ${n}`,
    lines: [
      orderLine(f, { when: null }),
      `The invoice was paid after the order was already ${status}, so the restaurant's payout was held back.`,
    ],
    action: 'decide whether to refund the diner or reinstate the order and pay the restaurant.',
    context: { ref, invoiceId },
  }))
}

// ── Refunds ───────────────────────────────────────────────────────────────────

export async function alertRefundRefused(ref: string, info: { refund: number; needed: number; holds: number }): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOps(withOrder(f, ref, {
    severity: 'warn',
    headline: `Refund refused — order ${n}`,
    lines: [
      orderLine(f, { when: null, amount: info.refund, amountLabel: 'refund' }),
      `It needs ${money(info.needed)} back from the restaurant's Stripe balance, which holds ${money(info.holds)} (${money(info.needed - info.holds)} short). Nothing was refunded.`,
    ],
    action: "retry after the restaurant's next orders land, or have Disco cover it as an exception.",
    context: { ref, ...info },
  }))
}

export async function alertRefundFromDiscoFunds(ref: string, info: { refund: number | null; invoiceId: string }): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOps(withOrder(f, ref, {
    severity: 'warn',
    headline: `Refunded from Disco's own funds — order ${n}`,
    lines: [
      orderLine(f, { when: null, amount: info.refund, amountLabel: 'refund' }),
      'The restaurant was never paid for this order, so there was nothing to take back. Disco covered the refund.',
    ],
    action: 'check why this order had no payout.',
    context: { ref, invoiceId: info.invoiceId },
  }))
}

export async function alertRestaurantKeptPayout(ref: string, info: { refund: number | null; transferId: string | null; error: unknown }): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOps(withOrder(f, ref, {
    severity: 'urgent',
    headline: `Diner refunded, restaurant kept its payout — order ${n}`,
    lines: [
      orderLine(f, { when: null, amount: info.refund, amountLabel: 'refund' }),
      `The refund went through, but taking the restaurant's share back failed because ${/sufficient funds/i.test(String(info.error)) ? 'their Stripe balance was too low' : `of an error (${shortError(info.error, 80)})`}. Disco is out that amount until it's recovered.`,
    ],
    action: `reverse ${info.transferId ? `transfer ${info.transferId}` : "the restaurant's transfer"} in Stripe once the restaurant's balance recovers.`,
    context: { ref, transferId: info.transferId, error: info.error instanceof Error ? info.error.message : String(info.error) },
  }))
}

// ── Order edits ───────────────────────────────────────────────────────────────

export async function alertEditVoidFailed(ref: string, invoiceId: string | null, error: unknown): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOps(withOrder(f, ref, {
    severity: 'warn',
    headline: `Order edit refused — ${n}`,
    lines: [
      f?.restaurant ?? '',
      "The restaurant lowered the order, but the old invoice couldn't be voided, so the edit was refused. The diner can still pay the old amount.",
    ],
    action: `void ${invoiceId ? `invoice ${invoiceId}` : 'the old invoice'} in Stripe, then ask the restaurant to redo the edit.`,
    context: { ref, invoiceId, error: String(error ?? '') },
  }))
}

export async function alertEditReissueFailed(ref: string, newTotal: number, error: unknown): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOps(withOrder(f, ref, {
    severity: 'urgent',
    headline: `Diner has no invoice to pay — ${n}`,
    lines: [
      orderLine(f, { when: null, amount: newTotal, amountLabel: 'new total' }),
      "The edit voided the old invoice, but creating the new one failed. The restaurant won't be paid until one is sent.",
    ],
    action: `create and send a ${money(newTotal)} invoice in Stripe.`,
    context: { ref, newTotal, error: error instanceof Error ? error.message : String(error) },
  }))
}

export async function alertEditRefundImpossible(ref: string, loweredBy: number): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOps(withOrder(f, ref, {
    severity: 'urgent',
    headline: `Edit refund not made — ${n}`,
    lines: [
      orderLine(f, { when: null, amount: loweredBy, amountLabel: 'lowered by' }),
      "Disco has no card payment for this order to refund against. The diner wasn't refunded or emailed.",
    ],
    action: `refund the diner ${money(loweredBy)} by hand and email them.`,
    context: { ref, loweredBy },
  }))
}

// ── Payments ──────────────────────────────────────────────────────────────────

export async function alertSoldOutRefundFailed(ref: string, item: string, paymentIntentId: string): Promise<void> {
  const { f, n } = await facts(ref)
  await alertOps(withOrder(f, ref, {
    severity: 'urgent',
    headline: `Diner charged for a sold-out item — order ${n}`,
    lines: [
      orderLine(f, { when: null }),
      `"${item}" sold out (daily limit) and the automatic refund failed. The order isn't confirmed.`,
    ],
    action: `refund payment ${paymentIntentId} in Stripe and let the diner know.`,
    context: { ref, item, paymentIntentId },
  }))
}

export async function alertPaymentMismatch(key: string, ref: string | null, info: { amount: number; what: string; detail: string }): Promise<void> {
  const { f, n } = ref ? await facts(ref) : { f: null, n: 'unknown order' }
  const a: OpsAlert = {
    severity: 'urgent',
    headline: `Stripe and Disco disagree about a payment — order ${n}`,
    lines: [orderLine(f, { when: null, amount: info.amount }), info.what],
    action: 'check the payment in Stripe, then confirm the order or refund it.',
    context: { ref, detail: info.detail },
  }
  await alertOnce(key, ref ? withOrder(f, ref, a) : a)
}

/**
 * "Stripe shows it paid, Disco shows it unconfirmed" closes once Disco's order
 * reaches a paid-or-later status. Only that direction: the other one (Disco
 * says paid, Stripe now says otherwise) is a dispute, which a person closes.
 * Deliberately NOT closed by the mismatch dropping out of the sweep's 26-hour
 * lookback — that is the check forgetting, not the problem going away.
 */
export async function resolvePaymentMismatches(): Promise<void> {
  const prefix = 'payment-reconciliation:stripe_succeeded_not_paid:'
  const keys = await openAlertKeys(prefix)
  const pis = keys.map(k => k.slice(prefix.length))
  if (!pis.length) return
  const rows = (await sql`
    SELECT p.stripe_payment_intent_id AS pi, o.order_status
      FROM disco_stripe_payments p JOIN disco_orders o ON o.reference = p.order_reference
     WHERE p.stripe_payment_intent_id = ANY(${pis})
  `.catch(() => [])) as Array<{ pi: string; order_status: string | null }>
  for (const r of rows) {
    if (['DUE', 'PAID', 'COMPLETED', 'REFUND', 'PARTIAL_REFUND'].includes(String(r.order_status ?? '').toUpperCase())) {
      await resolveAlert(`${prefix}${r.pi}`, 'Resolved: Stripe and Disco agree now.')
    }
  }
}
