import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql } from '../../../../../lib/db'
import { dispatchOrderConfirmations } from '../../../../../lib/order-notifications'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/admin/customers/resend-confirmation  { email }  or  { orderReference }
// Re-sends the Disco order-confirmation email to the customer — just the customer
// email (no restaurant email / SMS / Slack), forced past the once-only guard.
// Targets an explicit order reference, or the customer's most recent order by email.
export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let email = ''
  let orderReference = ''
  try {
    const body = await req.json()
    email = String(body?.email || '').trim().toLowerCase()
    orderReference = String(body?.orderReference || '').trim()
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
    await dispatchOrderConfirmations(orderId, 'ADMIN_RESEND', { force: true, customerOnly: true })
    return NextResponse.json({ ok: true, sentTo })
  } catch (e) {
    console.error('[admin/resend-confirmation] send failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'The confirmation email could not be sent.' }, { status: 500 })
  }
}
