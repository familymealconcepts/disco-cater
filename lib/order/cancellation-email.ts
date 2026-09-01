// The customer's "your order was canceled" email, in ONE place.
//
// THREE ROUTES CANCEL AN ORDER — status (orderStatus=CANCELED), reject, and void
// — and until now only void told the customer anything. The other two, which are
// the common paths, were silent. Cancelling is also deliberately status-only: it
// does NOT refund. So the silent path was precisely the one where the customer
// is left holding a charge.
//
// Living here rather than inline in each route is the point. Three copies of a
// notification block is how the two refund routes drifted, and how the two
// holiday lists drifted; this file exists so the next cancel path added gets the
// behaviour for free instead of re-deriving it.
import { sql } from '../db'
import { sendCustomerOrderCancellation } from '../email/notifications'

export interface CancellationEmailResult {
  sent: boolean
  /** Why not, when sent is false — for logging, never surfaced to a customer. */
  reason?: 'not-disco-source' | 'no-order' | 'no-email' | 'already-sent' | 'send-failed'
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
  cache_phone: string | null
  refund: string | null
  was_charged: boolean | null
}

/**
 * Claims the one-time send. Atomic via the partial unique index
 * disco_order_events_cancel_email_uq — the WHERE clause must match that index's
 * predicate exactly or Postgres cannot infer it. Same shape as
 * claimConfirmationSend in lib/order-notifications.ts.
 *
 * On a query failure this returns TRUE and sends: a rare duplicate is a better
 * failure than silently not telling someone their order was cancelled.
 */
async function claimCancellationEmail(orderReference: string, source: string): Promise<boolean> {
  try {
    const rows = (await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${orderReference}::uuid, 'CANCELLATION_EMAIL_SENT', '{}'::jsonb, ${source})
      ON CONFLICT (order_reference, event_type)
        WHERE event_type = 'CANCELLATION_EMAIL_SENT'
        DO NOTHING
      RETURNING id
    `) as { id: number }[]
    return rows.length > 0
  } catch (err) {
    console.error('[cancellation-email] claim failed (sending anyway):', err instanceof Error ? err.message : err)
    return true
  }
}

/**
 * Send the cancellation email for `ref` (a Disco order reference OR an FM order
 * reference — both are matched, as the cancel routes accept either).
 *
 * NEVER THROWS and never blocks the cancellation. A cancellation that succeeded
 * must not be reported as a failure because an email bounced.
 *
 * DISCO-SOURCE ONLY. disco_orders mirrors FAMILYMEAL-direct orders so the portal
 * can display them, and FM emails those customers itself from
 * mg.familymeal.com ("Order cancellation from {Restaurant}"). Disco sending a
 * second one is a duplicate in a stranger's inbox, not a safety net. Same rule
 * as the order-reminders cron.
 */
export async function sendOrderCancellationEmail(
  ref: string,
  source: string,
): Promise<CancellationEmailResult> {
  try {
    const rows = (await sql`
      SELECT o.reference, o.order_number, o.source_of_order,
             o.customer_email, o.customer_first_name, o.customer_last_name,
             o.restaurant_reference, o.restaurant_name,
             rc.name AS cache_name, rc.phone AS cache_phone,
             o.refund::text AS refund,
             EXISTS (
               SELECT 1 FROM disco_stripe_payments sp
               WHERE sp.order_reference = o.reference AND sp.status = 'SUCCEEDED'
             ) AS was_charged
      FROM disco_orders o
      LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
      WHERE o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as unknown as Row[]

    const o = rows[0]
    if (!o) return { sent: false, reason: 'no-order' }
    // source_of_order is NOT NULL DEFAULT 'DISCO', so this keeps every native
    // and DISCO-marketplace order and drops only FM-sourced mirrors.
    if ((o.source_of_order || 'DISCO') !== 'DISCO') return { sent: false, reason: 'not-disco-source' }
    if (!o.customer_email) return { sent: false, reason: 'no-email' }

    if (!(await claimCancellationEmail(o.reference, source))) return { sent: false, reason: 'already-sent' }

    const refunded = Number(o.refund) || 0
    const res = await sendCustomerOrderCancellation({
      to: o.customer_email,
      firstName: o.customer_first_name || undefined,
      lastName: o.customer_last_name || undefined,
      orderNumber: o.order_number ?? undefined,
      businessName: o.cache_name || o.restaurant_name || 'the restaurant',
      businessPhone: o.cache_phone || undefined,
      // Cancelling does not refund. wasCharged only makes the email SAY the
      // charge stands and the restaurant will be in touch — it never promises a
      // refund, because at this moment none has been issued.
      wasCharged: o.was_charged === true && refunded <= 0.005,
      // If money HAS already gone back (cancel after a refund), say so plainly
      // rather than implying a charge still stands.
      refundedAmount: refunded > 0.005 ? refunded : undefined,
    })
    return res.success ? { sent: true } : { sent: false, reason: 'send-failed' }
  } catch (err) {
    console.error('[cancellation-email] failed (non-fatal):', err instanceof Error ? err.message : err)
    return { sent: false, reason: 'send-failed' }
  }
}
