import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { findNativeOrder } from '../../../../../../lib/order/native-status-change'
import { sql } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/

// PUT /api/admin/orders/{ref}/date-time?restaurantReference=
// Body: { orderDate: "YYYY-MM-DD", orderTime: "HH:MM:SS" }
// Forwards to FM's super-admin date-time edit (the "Update Order Date & Time"
// popup). Mirrors the restaurant portal's reopen route, but on the admin
// userOrders namespace like the other admin order mutations.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const restaurantRef = req.nextUrl.searchParams.get('restaurantReference')
  const qs = restaurantRef ? `?restaurantReference=${restaurantRef}` : ''

  // ── Disco-native orders live only in Neon ─────────────────────────────────
  // FamilyMeal has no record of them, so this used to fail outright. Neon is the
  // source of truth, so the write lands there and an event records who moved it.
  //
  // DELIBERATELY NOT RE-VALIDATED against the restaurant's schedule, lead time or
  // blackouts. This is FM's super-admin override popup and its whole purpose is
  // to place an order somewhere the ordinary rules would refuse — the restaurant
  // portal's own edit flow is where the rules apply.
  const native = await findNativeOrder(ref)
  if (native) {
    let orderDate: string, orderTime: string
    try {
      const b = await req.json()
      orderDate = String(b?.orderDate ?? '').trim()
      orderTime = String(b?.orderTime ?? '').trim()
    } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }) }
    if (!DATE_RE.test(orderDate)) return NextResponse.json({ error: 'orderDate must be YYYY-MM-DD' }, { status: 400 })
    if (!TIME_RE.test(orderTime)) return NextResponse.json({ error: 'orderTime must be HH:MM or HH:MM:SS' }, { status: 400 })
    const time = orderTime.length === 5 ? `${orderTime}:00` : orderTime
    try {
      await sql`
        UPDATE disco_orders
           SET order_date = ${orderDate}::date, order_time = ${time}::time, updated_at = NOW()
         WHERE reference = ${ref}::uuid
      `
      await sql`
        INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
        VALUES (${ref}::uuid, 'DATE_TIME_CHANGED', ${JSON.stringify({ orderDate, orderTime: time })}::jsonb, 'ADMIN_DATE_TIME')
      `.catch(e => console.error('[admin/orders/date-time] event insert (non-fatal):', e instanceof Error ? e.message : e))
      return NextResponse.json({ ok: true, orderDate, orderTime: time, neon: true })
    } catch (e) {
      console.error('[admin/orders/date-time] native update failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to update date/time' }, { status: 500 })
    }
  }

  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/admin/userOrders/${ref}/date-time${qs}`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to update date/time' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update date/time' }, { status: 500 })
  }
}
