// The customer's refund email, in ONE place — the same consolidation the
// cancellation email got, and for the same reason.
//
// Three paths refund an order (the restaurant route, the admin route, and
// refundNativeOrder) and each had grown its own copy of the recipient lookup and
// the send. That is the shape that let the two refund routes drift over the
// post-refund block, and it is why the source filter below was missing from all
// three at once.
//
// SKIPPED ONLY WHEN FAMILYMEAL PROCESSED THE ORDER. disco_orders mirrors
// FamilyMeal's own orders so the portal can display them, and FM emails those
// customers itself — verified live in Mailgun, where FM sends "Order refund from
// {Restaurant} #{orderNumber}" from mg.familymeal.com. Disco adding a second
// message is a duplicate in a stranger's inbox. A mirrored FM order is one with
// an fm_order_reference.
//
// Every order DISCO processed gets the email, whichever link the customer used.
// This used to test source_of_order = 'DISCO', but source_of_order is the
// marketing channel (1P link vs Disco marketplace), not who took the money: a
// native order placed through a restaurant's own link is 'FAMILYMEAL', and
// FamilyMeal has no record of it. So those refunds went out with no email at
// all — 8 of them from 31 Aug to 24 Oct 2026, including #900000598 (Apollo
// Bagels - FiDi, $113.61), whose confirmation Disco had sent itself.
import { sql } from '../db'
import { sendCustomerRefundNotification } from '../email/notifications'
import { editRefundedFor, nonEditRefunded } from './refundable'

export interface RefundEmailArgs {
  /** Disco order reference (uuid). FM references are matched too. */
  orderReference: string
  /** THIS refund's amount. */
  amount: number
  /** Cumulative refunded INCLUDING this refund. */
  totalRefunded: number
  /** Whole-order total, when known — omitted from the email when 0/absent. */
  orderTotal?: number
  /** From the route's own newStatus, so email and status cannot disagree. */
  isPartial: boolean
  /**
   * Whether the order is still going ahead. Tri-state: undefined means "don't
   * say", which is correct whenever the caller cannot establish it. Callers
   * derive this from the status BEFORE the refund overwrote it.
   */
  orderProceeding?: boolean
}

export interface RefundEmailResult {
  sent: boolean
  reason?: 'familymeal-order' | 'no-order' | 'no-email' | 'send-failed'
}

interface Row {
  reference: string
  order_number: string | number | null
  fm_order_reference: string | null
  customer_email: string | null
  customer_first_name: string | null
  customer_last_name: string | null
  restaurant_reference: string | null
  restaurant_name: string | null
  cache_name: string | null
}

/**
 * NEVER THROWS and never blocks a refund. A refund that actually moved money
 * must not be reported as failed because an email bounced — the same principle
 * the refund routes already apply to their own error handling.
 */
export async function sendOrderRefundEmail(args: RefundEmailArgs): Promise<RefundEmailResult> {
  try {
    const rows = (await sql`
      SELECT o.reference, o.order_number, o.fm_order_reference,
             o.customer_email, o.customer_first_name, o.customer_last_name,
             o.restaurant_reference, o.restaurant_name,
             rc.name AS cache_name
      FROM disco_orders o
      LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
      WHERE o.reference = ${args.orderReference}::uuid OR o.fm_order_reference = ${args.orderReference}::uuid
      LIMIT 1
    `) as unknown as Row[]

    const o = rows[0]
    if (!o) return { sent: false, reason: 'no-order' }
    // FamilyMeal processed it (a mirrored FM order) → FM sends its own email.
    if (o.fm_order_reference) return { sent: false, reason: 'familymeal-order' }
    if (!o.customer_email) return { sent: false, reason: 'no-email' }

    // "leaving $X charged" = the order's (lowered) total less the refunds that
    // did NOT come from an edit — an edit's refund is already inside the lowered
    // total (lib/order/refundable.ts). Counting it again told #900000598's
    // customer $629.03 was left when their card held $673.78.
    const editRefunded = await editRefundedFor(String(o.reference)).catch(() => 0)
    const res = await sendCustomerRefundNotification({
      to: o.customer_email,
      firstName: o.customer_first_name || '',
      lastName: o.customer_last_name || undefined,
      orderNumber: o.order_number ?? o.reference,
      refundAmount: args.amount,
      businessName: o.cache_name || o.restaurant_name || 'the restaurant',
      orderTotal: args.orderTotal && args.orderTotal > 0 ? args.orderTotal : undefined,
      totalRefunded: nonEditRefunded(args.totalRefunded, editRefunded),
      isPartial: args.isPartial,
      orderProceeding: args.orderProceeding,
    })
    return res.success ? { sent: true } : { sent: false, reason: 'send-failed' }
  } catch (err) {
    console.error('[refund-email] failed (non-fatal):', err instanceof Error ? err.message : err)
    return { sent: false, reason: 'send-failed' }
  }
}
