import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { findNativeOrder } from '../../../../../../lib/order/native-status-change'
import { sql } from '../../../../../../lib/db'
import { sendOrderUpdated, sendOrderUpdatedRestaurant } from '../../../../../../lib/email/notifications'
import { resolveRestaurantNotificationEmails } from '../../../../../../lib/order-notifications'
import { loadOrderItemsWithAddOns } from '../../../../../../lib/order-items'
import { buildOrderPdfByReference } from '../../../../../../lib/order/order-pdf'
import { orderPdfFilename } from '../../../../../../lib/download-filename'
import { fmtDateHuman } from '../../../../../../lib/order-edit'
import { formatTime12 as fmtTimeHuman } from '../../../../../../lib/utils/time'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/

/**
 * The pair FamilyMeal sends on a date/time change: customer + every configured
 * restaurant recipient, same content, order PDF attached. Never throws — the
 * change is already saved by the time this runs.
 */
async function notifyDateTimeChanged(orderRef: string, orderDate: string, orderTime: string): Promise<void> {
  try {
    const rows = (await sql`
      SELECT o.id, o.order_number, o.customer_email, o.customer_first_name,
             o.restaurant_reference::text AS restaurant_reference, o.restaurant_email,
             COALESCE(o.restaurant_name, rc.name, 'the restaurant') AS business_name,
             COALESCE(o.total, 0)::float8 AS total
        FROM disco_orders o
        LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
       WHERE o.reference = ${orderRef}::uuid LIMIT 1
    `) as Array<{ id: number; order_number: string | number; customer_email: string | null; customer_first_name: string | null; restaurant_reference: string | null; restaurant_email: string | null; business_name: string; total: number }>
    const o = rows[0]
    if (!o) return

    const lines = await loadOrderItemsWithAddOns(o.id).catch(() => [])
    const items = lines.map(l => ({ count: l.quantity, name: l.name, price: l.pricePerUnit }))
    const dateStr = fmtDateHuman(orderDate)
    const timeStr = fmtTimeHuman(orderTime)

    if (o.customer_email) {
      await sendOrderUpdated({
        to: o.customer_email, firstName: o.customer_first_name || '',
        orderNumber: o.order_number, businessName: o.business_name,
        orderDate: dateStr, orderTime: timeStr, items, newTotal: o.total, delta: 0,
      }).catch(e => console.error('[admin/orders/date-time] customer email:', e))
    }

    // The half that matters — the kitchen plans around the time.
    const restaurantEmails = await resolveRestaurantNotificationEmails(o.restaurant_reference, o.restaurant_email)
    if (!restaurantEmails.length) {
      console.warn('[admin/orders/date-time] no restaurant recipient at any fallback level:', orderRef)
      return
    }
    let attachments: { filename: string; content: Uint8Array; contentType: string }[] | undefined
    try {
      const pdf = await buildOrderPdfByReference(orderRef)
      if (pdf) attachments = [{ filename: orderPdfFilename(o.business_name, o.order_number, orderRef), content: pdf, contentType: 'application/pdf' }]
    } catch (e) { console.error('[admin/orders/date-time] PDF build failed:', e instanceof Error ? e.message : e) }

    for (const to of restaurantEmails) {
      await sendOrderUpdatedRestaurant({
        to, orderNumber: o.order_number, businessName: o.business_name,
        orderDate: dateStr, orderTime: timeStr, items, newTotal: o.total, delta: 0,
        changeSummary: `The date and time changed to ${dateStr} at ${timeStr}.`,
        attachments,
      }).catch(e => console.error('[admin/orders/date-time] restaurant email:', e))
    }
  } catch (e) {
    console.error('[admin/orders/date-time] notify failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}


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

      // ── TELL BOTH SIDES, LIKE FAMILYMEAL DOES ─────────────────────────────
      // FM's updateOrderDateAndTime does exactly one thing after saving:
      //
      //     RestaurantOrder order = editRestaurantOrderDateAndTime(orderReference, orderDate, orderTime);
      //     byte[] attachment = orderEmailHelper.createAndSendOrderConfirmation(order);
      //
      // and that helper's sendOrderCustomerNotificationfordateandtimeupdate sends
      // the SAME "ORDER CHANGE" template, with the order PDF attached, to the
      // customer and then to every address in
      // getRestaurantNotificationEmailsDeduplicated(restaurant). This route sent
      // nothing at all. Best-effort: the date change is already committed and an
      // email failure must not report it as failed.
      await notifyDateTimeChanged(ref, orderDate, time)

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
