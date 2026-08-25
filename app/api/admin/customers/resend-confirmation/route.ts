import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql } from '../../../../../lib/db'
import { dispatchOrderConfirmations } from '../../../../../lib/order-notifications'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/admin/customers/resend-confirmation
//   { email } or { orderReference }, plus optional { includeRestaurant: true }
//
// Re-sends the Disco order confirmation, forced past the once-only guard.
//
// DEFAULT IS CUSTOMER-ONLY and stays that way: this endpoint exists for "the
// customer says they never got it", where re-notifying the restaurant of an
// order it has already been working is noise at best and confusing at worst.
//
// includeRestaurant:true opts into the FULL dispatch — customer plus every
// address in disco_restaurant_overrides.notification_emails. That is for the
// different failure, where nobody was notified at all: order 900000094 claimed
// ORDER_CONFIRMATIONS_SENT and sent nothing, so its restaurant genuinely never
// heard about a $104.51 delivery. Opt-in rather than the default because
// re-notifying a restaurant is only correct when it was never notified.
//
// Safe to run more than once by design. The Slack ping cannot duplicate — the
// full dispatch gates it on claimSlackNotified(), and SLACK_NOTIFIED is already
// present on any order that got this far. Restaurant SMS is NOT so gated and
// will re-send if that restaurant has text notifications enabled; that is
// reported back in the response rather than suppressed, so the caller knows.
export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let email = ''
  let orderReference = ''
  let includeRestaurant = false
  try {
    const body = await req.json()
    email = String(body?.email || '').trim().toLowerCase()
    orderReference = String(body?.orderReference || '').trim()
    includeRestaurant = body?.includeRestaurant === true
  } catch { /* fields stay empty */ }

  let orderId: number | null = null
  let sentTo = ''
  try {
    if (orderReference && UUID_RE.test(orderReference)) {
      const rows = (await sql`
        SELECT id, customer_email FROM disco_orders
        WHERE reference = ${orderReference}::uuid OR fm_order_reference = ${orderReference}::uuid
        LIMIT 1
      `) as { id: number; customer_email: string | null }[]
      orderId = rows[0]?.id ?? null
      sentTo = rows[0]?.customer_email ?? ''
    } else if (email) {
      const rows = (await sql`
        SELECT id, customer_email FROM disco_orders
        WHERE LOWER(customer_email) = ${email} AND is_deleted = false
        ORDER BY created_at DESC LIMIT 1
      `) as { id: number; customer_email: string | null }[]
      orderId = rows[0]?.id ?? null
      sentTo = rows[0]?.customer_email ?? ''
    } else {
      return NextResponse.json({ error: 'A customer email or order reference is required.' }, { status: 400 })
    }
  } catch (e) {
    console.error('[admin/resend-confirmation] lookup failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to look up the order.' }, { status: 500 })
  }

  if (!orderId) return NextResponse.json({ error: 'No order found for this customer.' }, { status: 404 })
  if (!sentTo) return NextResponse.json({ error: 'That order has no customer email on file.' }, { status: 400 })

  try {
    await dispatchOrderConfirmations(orderId, 'ADMIN_RESEND', { force: true, customerOnly: !includeRestaurant })
    // Read the per-recipient outcome back off the event row the dispatch just
    // wrote (see recordConfirmationOutcome). This is the whole reason that data
    // is recorded: the caller learns which addresses actually took the message
    // and what Mailgun's id was, instead of a bare ok:true that is exactly what
    // ORDER_CONFIRMATIONS_SENT used to assert while sending nothing.
    let recipients: unknown = null
    try {
      const ev = (await sql`
        SELECT event_data FROM disco_order_events
        WHERE order_reference = (SELECT reference FROM disco_orders WHERE id = ${orderId})
          AND event_type = 'ORDER_CONFIRMATIONS_SENT' LIMIT 1
      `) as { event_data: unknown }[]
      recipients = ev[0]?.event_data ?? null
    } catch { /* the send already happened; reporting is best-effort */ }
    return NextResponse.json({ ok: true, sentTo, includeRestaurant, outcome: recipients })
  } catch (e) {
    console.error('[admin/resend-confirmation] send failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'The confirmation email could not be sent.' }, { status: 500 })
  }
}
