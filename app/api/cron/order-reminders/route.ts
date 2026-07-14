import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import {
  sendCustomerOrderReminder, sendRestaurantOrderReminder, type OrderMealPackage,
} from '../../../../lib/email/notifications'
import { formatTimeWindow } from '../../../../lib/utils/deliveryTimeWindow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Hourly order-reminder cron — mirrors FamilyMeal's verified reminder behavior
// (familymeal-java-backend: reminder-time 24h, admin-reminder-hours 24h). FM runs
// every minute; Vercel Pro runs us hourly, so we select a 1-hour window centered
// on the 24h mark (23.5h–24.5h from now) in the RESTAURANT's timezone.
//
// Two passes per run, both on the same 24h window + placement skip:
//   1. CUSTOMER reminder — gated on order_reminder_emails_enabled. Idempotent via
//      an ORDER_REMINDER_SENT marker in disco_order_events.
//   2. RESTAURANT/ADMIN reminder — gated on admin_order_reminder_emails_enabled,
//      sent to the restaurant notification-email list. Idempotent via the
//      disco_orders.admin_reminder_sent column.
//
// Placement skip (BOTH passes — FM applies it to the admin reminder; the Disco
// Cater decision is to apply it to the customer reminder too): never remind if the
// order was placed less than 24h before pickup (created_at <= pickup − 24h).
//
// The toggles live in FM (session-scoped) and are mirrored into
// disco_restaurant_overrides on every settings save — this cron reads that mirror
// because it has no restaurant session. Auth: `Authorization: Bearer ${CRON_SECRET}`.

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

// MM/DD/YYYY (FM email format).
function fmtDate(iso: string): string {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number)
  if (!y) return String(iso || '')
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
}

const splitCsv = (v: string | null | undefined): string[] =>
  String(v || '').split(',').map(s => s.trim()).filter(Boolean)

// Shape returned by both reminder selection queries.
interface ReminderRow {
  id: number; reference: string; order_number: string | number; order_type: string
  order_date: string; order_time: string
  customer_email: string | null; customer_first_name: string | null
  customer_last_name: string | null; customer_phone: string | null
  delivery_address_line1: string | null; delivery_address_line2: string | null
  delivery_city: string | null; delivery_state: string | null; delivery_zip: string | null
  subtotal: string | null; fee: string | null; tips: string | null; total: string | null
  restaurant_reference: string; restaurant_name: string | null; restaurant_email: string | null
  cache_name: string | null; cache_phone: string | null; cache_address: string | null
  notif_emails: string | null; delivery_time_window: string | null; note: string | null
}

// Atomically claim the one-time CUSTOMER reminder for an order. Returns true only
// for the caller that inserts the ORDER_REMINDER_SENT marker (so it should send).
async function claimCustomerReminder(orderReference: string): Promise<boolean> {
  try {
    const rows = (await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      SELECT ${orderReference}::uuid, 'ORDER_REMINDER_SENT', '{}'::jsonb, 'cron/order-reminders'
      WHERE NOT EXISTS (
        SELECT 1 FROM disco_order_events
        WHERE order_reference = ${orderReference}::uuid AND event_type = 'ORDER_REMINDER_SENT'
      )
      RETURNING id
    `) as { id: number }[]
    return rows.length > 0
  } catch (err) {
    console.error('[cron/order-reminders] customer claim failed (skipping to avoid dup):', err instanceof Error ? err.message : err)
    return false
  }
}

// Atomically claim the RESTAURANT/ADMIN reminder via the admin_reminder_sent flag.
async function claimAdminReminder(orderId: number): Promise<boolean> {
  try {
    const rows = (await sql`
      UPDATE disco_orders SET admin_reminder_sent = true, updated_at = NOW()
      WHERE id = ${orderId} AND admin_reminder_sent = false
      RETURNING id
    `) as { id: number }[]
    return rows.length > 0
  } catch (err) {
    console.error('[cron/order-reminders] admin claim failed (skipping to avoid dup):', err instanceof Error ? err.message : err)
    return false
  }
}

// Line items for an order's reminder body.
async function loadPackages(orderId: number): Promise<OrderMealPackage[]> {
  const items = (await sql`
    SELECT name, quantity, price_per_unit FROM disco_order_items WHERE order_id = ${orderId} ORDER BY id
  `) as { name: string; quantity: number; price_per_unit: string }[]
  return items.map((it) => ({
    count: num(it.quantity) || 1,
    name: String(it.name ?? ''),
    price: num(it.price_per_unit),
  }))
}

// Compose the single-line delivery address (DELIVERY orders only).
function deliveryAddress(o: ReminderRow): string {
  if (String(o.order_type || '').toUpperCase() !== 'DELIVERY') return ''
  const cityLine = [o.delivery_city, o.delivery_state].filter(Boolean).join(', ')
  return [o.delivery_address_line1, [cityLine, o.delivery_zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ')
}

// Shared SELECT + FROM/JOIN + 24h-window + placement-skip. The two passes differ
// only in the toggle column and the idempotency filter, appended by the caller.
export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await runMigrations()

    // ── PASS 1 — CUSTOMER reminders ─────────────────────────────────────────
    // Orders whose pickup instant is 23.5h–24.5h from now (restaurant tz), placed
    // ≥24h before pickup, status DUE, ALL order types, reminder toggle ON.
    const custOrders = (await sql`
      SELECT o.id, o.reference, o.order_number, o.order_type,
             to_char(o.order_date,'YYYY-MM-DD') AS order_date, o.order_time::text AS order_time,
             o.customer_email, o.customer_first_name, o.customer_last_name, o.customer_phone,
             o.delivery_address_line1, o.delivery_address_line2, o.delivery_city, o.delivery_state, o.delivery_zip,
             o.subtotal, o.fee, o.tips, o.restaurant_reference, o.restaurant_name, o.restaurant_email,
             COALESCE(NULLIF(o.total, 0),
               (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.total > 0)
             ) AS total,
             rc.name AS cache_name, rc.phone AS cache_phone, rc.address AS cache_address,
             ov.notification_emails AS notif_emails, o.delivery_time_window, o.note
      FROM disco_orders o
      JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = o.restaurant_reference::text
      LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
      WHERE ov.order_reminder_emails_enabled = true
        AND o.order_status = 'DUE'
        AND o.is_deleted = false
        -- DISCO-source only. disco_orders also mirrors FAMILYMEAL-direct orders
        -- (synced in so the portal can display them). FamilyMeal sends those
        -- customers their own reminder from noreply@mg.familymeal.com — Disco must
        -- NOT also email them from orders@discocater.com. source_of_order is
        -- NOT NULL DEFAULT 'DISCO', so this keeps all native + DISCO orders.
        AND o.source_of_order = 'DISCO'
        AND o.customer_email IS NOT NULL AND o.customer_email <> ''
        AND ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))
              BETWEEN NOW() + INTERVAL '23 hours 30 minutes' AND NOW() + INTERVAL '24 hours 30 minutes'
        AND o.created_at <= ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York')) - INTERVAL '24 hours'
    `) as ReminderRow[]

    let customerSent = 0
    let customerSkipped = 0
    for (const o of custOrders) {
      if (!(await claimCustomerReminder(o.reference))) { customerSkipped++; continue }
      const packages = await loadPackages(o.id)
      const res = await sendCustomerOrderReminder({
        to: o.customer_email as string,
        firstName: o.customer_first_name || undefined,
        lastName: o.customer_last_name || undefined,
        orderService: String(o.order_type || ''),
        orderDate: fmtDate(o.order_date),
        orderTime: formatTimeWindow(o.order_time, o.delivery_time_window, String(o.order_type || '').toUpperCase() === 'DELIVERY'),
        orderReceived: '',
        orderMealPackages: packages,
        subtotal: num(o.subtotal),
        fees: num(o.fee),
        tip: num(o.tips),
        totalPrice: num(o.total),
        orderNumber: o.order_number,
        note: o.note || undefined,
        businessName: o.cache_name || o.restaurant_name || 'the restaurant',
        businessPhone: o.cache_phone || undefined,
        addressLine1: o.cache_address || undefined,
      })
      if (res.success) customerSent++
    }

    // ── PASS 2 — RESTAURANT / ADMIN reminders ───────────────────────────────
    // Same 24h window + placement skip; gated on admin_order_reminder_emails_enabled
    // and admin_reminder_sent; ALL order types; sent to the restaurant email list.
    const adminOrders = (await sql`
      SELECT o.id, o.reference, o.order_number, o.order_type,
             to_char(o.order_date,'YYYY-MM-DD') AS order_date, o.order_time::text AS order_time,
             o.customer_email, o.customer_first_name, o.customer_last_name, o.customer_phone,
             o.delivery_address_line1, o.delivery_address_line2, o.delivery_city, o.delivery_state, o.delivery_zip,
             o.subtotal, o.fee, o.tips, o.restaurant_reference, o.restaurant_name, o.restaurant_email,
             COALESCE(NULLIF(o.total, 0),
               (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.total > 0)
             ) AS total,
             rc.name AS cache_name, rc.phone AS cache_phone, rc.address AS cache_address,
             ov.notification_emails AS notif_emails, o.delivery_time_window, o.note
      FROM disco_orders o
      JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = o.restaurant_reference::text
      LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
      WHERE ov.admin_order_reminder_emails_enabled = true
        AND o.admin_reminder_sent = false
        AND o.order_status = 'DUE'
        AND o.is_deleted = false
        AND ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))
              BETWEEN NOW() + INTERVAL '23 hours 30 minutes' AND NOW() + INTERVAL '24 hours 30 minutes'
        AND o.created_at <= ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York')) - INTERVAL '24 hours'
    `) as ReminderRow[]

    let adminSent = 0
    let adminSkipped = 0
    for (const o of adminOrders) {
      // Recipients: the restaurant notification-email list, fallback to the order's
      // restaurant_email. Skip (and don't claim) if there's nobody to notify.
      const recipients = splitCsv(o.notif_emails)
      if (recipients.length === 0 && o.restaurant_email) recipients.push(o.restaurant_email)
      if (recipients.length === 0) { adminSkipped++; continue }

      // Claim first so overlapping runs can't double-send.
      if (!(await claimAdminReminder(o.id))) { adminSkipped++; continue }

      const packages = await loadPackages(o.id)
      const addr = deliveryAddress(o)
      let anySent = false
      for (const to of recipients) {
        const res = await sendRestaurantOrderReminder({
          to,
          firstName: o.customer_first_name || undefined,
          lastName: o.customer_last_name || undefined,
          userEmail: o.customer_email || undefined,
          userPhoneNumber: o.customer_phone || undefined,
          dinerAddress: addr || undefined,
          orderService: String(o.order_type || ''),
          orderDate: fmtDate(o.order_date),
          orderTime: formatTimeWindow(o.order_time, o.delivery_time_window, String(o.order_type || '').toUpperCase() === 'DELIVERY'),
          orderReceived: '',
          orderMealPackages: packages,
          subtotal: num(o.subtotal),
          fees: num(o.fee),
          tip: num(o.tips),
          totalPrice: num(o.total),
          orderNumber: o.order_number,
          note: o.note || undefined,
          businessName: o.cache_name || o.restaurant_name || 'the restaurant',
          businessPhone: o.cache_phone || undefined,
          addressLine1: o.cache_address || undefined,
        })
        if (res.success) anySent = true
      }
      if (anySent) adminSent++
    }

    return NextResponse.json({
      ok: true,
      customer: { candidates: custOrders.length, sent: customerSent, skipped: customerSkipped },
      restaurant: { candidates: adminOrders.length, sent: adminSent, skipped: adminSkipped },
    })
  } catch (err) {
    console.error('[cron/order-reminders] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Reminder run failed' }, { status: 500 })
  }
}
