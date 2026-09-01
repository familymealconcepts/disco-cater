// The customer's refund email, in ONE place — the same consolidation the
// cancellation email got, and for the same reason.
//
// Three paths refund an order (the restaurant route, the admin route, and
// refundNativeOrder) and each had grown its own copy of the recipient lookup and
// the send. That is the shape that let the two refund routes drift over the
// post-refund block, and it is why the source filter below was missing from all
// three at once.
//
// DISCO-SOURCE ONLY. disco_orders mirrors FAMILYMEAL-direct orders so the portal
// can display them, and FM emails those customers itself — verified live in
// Mailgun, where FM sends "Order refund from {Restaurant} #{orderNumber}" from
// mg.familymeal.com. FM owns FM-sourced orders end to end: reminders,
// cancellations and refunds. Disco adding a second message is a duplicate in a
// stranger's inbox.
import { sql } from '../db'
import { sendCustomerRefundNotification } from '../email/notifications'

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
  reason?: 'not-disco-source' | 'no-order' | 'no-email' | 'send-failed'
}

interface Row {
  reference: string
  order_number: string | number | null
  source_of_order: string | null
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
      SELECT o.reference, o.order_number, o.source_of_order,
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
    // source_of_order is NOT NULL DEFAULT 'DISCO', so this keeps every native
    // and DISCO-marketplace order and drops only FM-sourced mirrors.
    if ((o.source_of_order || 'DISCO') !== 'DISCO') return { sent: false, reason: 'not-disco-source' }
    if (!o.customer_email) return { sent: false, reason: 'no-email' }

    const res = await sendCustomerRefundNotification({
      to: o.customer_email,
      firstName: o.customer_first_name || '',
      lastName: o.customer_last_name || undefined,
      orderNumber: o.order_number ?? o.reference,
      refundAmount: args.amount,
      businessName: o.cache_name || o.restaurant_name || 'the restaurant',
      orderTotal: args.orderTotal && args.orderTotal > 0 ? args.orderTotal : undefined,
      totalRefunded: args.totalRefunded,
      isPartial: args.isPartial,
      orderProceeding: args.orderProceeding,
    })
    return res.success ? { sent: true } : { sent: false, reason: 'send-failed' }
  } catch (err) {
    console.error('[refund-email] failed (non-fatal):', err instanceof Error ? err.message : err)
    return { sent: false, reason: 'send-failed' }
  }
}
