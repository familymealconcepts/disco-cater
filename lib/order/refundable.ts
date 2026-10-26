// How much of an order can still be refunded — ONE rule for the refund routes,
// the order list and the order drawer.
//
// ── WHY AN EDIT'S REFUND MUST NOT BE SUBTRACTED TWICE ───────────────────────
// An order edit that lowers the price does two things: it lowers
// disco_orders.total to the new price, and it refunds the difference to the
// card. That refund then lands in disco_orders.refund too (the charge.refunded
// webhook writes Stripe's running refunded total there). So `total - refund`
// takes the edit off twice: once through the lower total, once through the
// refund. On #900000598 (Apollo Bagels - FiDi, 24 Oct 2026) the customer paid
// $832.14, an edit cut the order to $787.39 and refunded $44.75, the portal
// then refunded $113.61 — and Disco said $629.03 was left when the card still
// held $673.78. A "full" refund from there would have marked the order
// Refunded with the customer $44.75 short.
//
// The rule: the current total, less only the refunds that did NOT come from an
// edit. An edit's refund is already inside the lower total.
import { sql } from '../db'

/** SQL column expression: what this order's edits have refunded to the card.
 *  `orderTable` is the name or alias the query gives disco_orders. */
export function editRefundedSql(orderTable: string): string {
  return `(SELECT COALESCE(SUM(-e.delta), 0) FROM disco_order_edits e
           WHERE e.fm_order_reference IN (${orderTable}.reference, ${orderTable}.fm_order_reference)
             AND e.payment_status = 'refunded' AND e.delta < 0)`
}

/** What one order's edits have refunded to the card (by Disco or FM reference). */
export async function editRefundedFor(orderReference: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(-e.delta), 0) AS v FROM disco_order_edits e
    JOIN disco_orders o ON e.fm_order_reference IN (o.reference, o.fm_order_reference)
    WHERE (o.reference = ${orderReference}::uuid OR o.fm_order_reference = ${orderReference}::uuid)
      AND e.payment_status = 'refunded' AND e.delta < 0
  `) as { v: string }[]
  return Number(rows[0]?.v) || 0
}

/** Refunds that came from somewhere other than an order edit. */
export function nonEditRefunded(refund: number, editRefunded: number): number {
  return Math.max(0, Math.round(((Number(refund) || 0) - (Number(editRefunded) || 0)) * 100) / 100)
}

/** What can still be refunded on the card. */
export function refundableAmount(total: number, refund: number, editRefunded: number): number {
  return Math.max(0, Math.round(((Number(total) || 0) - nonEditRefunded(refund, editRefunded)) * 100) / 100)
}
