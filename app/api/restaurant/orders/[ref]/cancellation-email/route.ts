import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { sql } from '../../../../../../lib/db'
import { sendOrderCancellationEmail } from '../../../../../../lib/order/cancellation-email'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/restaurant/orders/{ref}/cancellation-email
// The Refund dialog the Cancel button opens was closed without a refund (No
// Refund, Cancel, or leaving the page): send the plain cancellation email the
// cancel deferred. Only for an order whose email WAS deferred, so this can't
// send an email the cancel didn't owe; the one-time claim inside the helper
// stops a repeat. See lib/order/cancellation-email.ts.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  const rows = (await sql`
    SELECT o.reference::text AS reference FROM disco_orders o
    WHERE (o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid)
      AND EXISTS (SELECT 1 FROM disco_order_events d
                  WHERE d.order_reference = o.reference AND d.event_type = 'CANCELLATION_EMAIL_DEFERRED')
    LIMIT 1
  `) as { reference: string }[]
  if (!rows.length) return NextResponse.json({ ok: true, sent: false, reason: 'not-deferred' })
  const r = await sendOrderCancellationEmail(rows[0].reference, 'DISCO_STATUS')
  return NextResponse.json({ ok: true, ...r })
}
