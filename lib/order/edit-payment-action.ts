// Which money action an order edit should take.
//
// Extracted from app/api/restaurant/orders/[ref]/edit/route.ts so the decision
// can be tested exhaustively WITHOUT executing Stripe calls or sending a
// customer an email — the route's own branches do both as side effects, so the
// rule was previously only observable by running it against a real order.
//
// ── THE CASE THIS EXISTS FOR ────────────────────────────────────────────────
// The route branched on the SIGN OF THE DELTA alone: delta > 0 charged or
// invoiced, delta < 0 refunded, with no check that the order had ever been
// paid. Order #900000303 (Apollo Bagels - Kips Bay, 2026-10-06) was a
// direct-entry invoice order that was never paid — invoice open, amount_paid
// $0.00, no charge, no PaymentIntent. Reducing its quantities produced a
// -$172.29 delta, which took the refund branch, found nothing to refund, and
// recorded payment_status='failed' while the customer was emailed that $172.29
// was on its way back to her.
//
// Refunding returns money a customer handed over. Voiding an unpaid invoice
// withdraws a bill that was never paid. They are categorically different, and
// lib/order/invoice-void.ts already says so in its own header — the cancel path
// has made this distinction correctly since it was written. The edit path
// simply never asked the question.

export type EditPaymentAction = 'charge' | 'refund' | 'invoice' | 'void-reissue' | 'none'

export interface EditPaymentContext {
  /** New total minus old total, in dollars. */
  delta: number
  /** disco_orders.order_status */
  orderStatus: string | null
  /** disco_orders.stripe_invoice_id */
  invoiceId: string | null
  /** disco_orders.stripe_invoice_status */
  invoiceStatus: string | null
}

/** An order billed by invoice that the customer has not paid yet. */
export function isUnpaidInvoiceOrder(ctx: EditPaymentContext): boolean {
  if (String(ctx.orderStatus || '').toUpperCase() !== 'UNPAID') return false
  if (!ctx.invoiceId) return false
  const s = String(ctx.invoiceStatus || '').toLowerCase()
  // 'void' and 'paid' are both terminal and neither is reissuable. An empty
  // status is treated as open: the column is a mirror and may lag Stripe, and
  // voidUnpaidOrderInvoice re-reads Stripe before acting anyway.
  return s !== 'void' && s !== 'paid'
}

/**
 * Decide the money action for an edit.
 *
 * VOID-REISSUE IS CHECKED BEFORE REFUND, and that ordering is the fix. A
 * reduction on an unpaid invoice order must withdraw and re-bill, never refund:
 * there is no payment to refund, so the refund branch can only fail — and
 * before this it failed while telling the customer otherwise.
 */
export function decideEditPaymentAction(ctx: EditPaymentContext): EditPaymentAction {
  if (ctx.delta === 0) return 'none'

  if (isUnpaidInvoiceOrder(ctx)) {
    // Nothing has been collected, so the whole bill is restated either way:
    // down, and up, are both "void the stale invoice and issue the right one".
    // The positive case keeps its existing behaviour for now (it already
    // invoices, and that path is proven); only the negative case changes, which
    // is the one that was reaching the refund branch.
    if (ctx.delta < 0) return 'void-reissue'
    return 'invoice'
  }

  return ctx.delta > 0 ? 'charge' : 'refund'
}
