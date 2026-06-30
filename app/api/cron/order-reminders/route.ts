import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { sendCustomerOrderReminder, type OrderMealPackage } from '../../../../lib/email/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Daily customer order-reminder cron. Sends sendCustomerOrderReminder to the
// customer for each upcoming order (order_date == tomorrow) belonging to a
// restaurant that has "Customer Order Reminder Emails" ON. The toggle + behaviour
// live in FM (session-scoped) and are mirrored into
// disco_restaurant_overrides.order_reminder_emails_enabled on every settings save
// — this cron reads that mirror because it has no restaurant session.
//
// Idempotent: an ORDER_REMINDER_SENT marker in disco_order_events guards against
// re-sending. Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

// Tomorrow as YYYY-MM-DD in UTC (matches the DATE column semantics).
function tomorrowUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// MM/DD/YYYY (FM email format).
function fmtDate(iso: string): string {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number)
  if (!y) return String(iso || '')
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
}
function fmtTime(v: unknown): string {
  if (!v) return ''
  const [h, mm] = String(v).split(':').map(Number)
  if (isNaN(h)) return String(v)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(mm || 0).padStart(2, '0')} ${ampm}`
}

// Atomically claim the one-time reminder send for an order. Returns true only for
// the caller that inserts the ORDER_REMINDER_SENT marker (so it should send).
async function claimReminder(orderReference: string): Promise<boolean> {
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
    console.error('[cron/order-reminders] claim failed (skipping to avoid dup):', err instanceof Error ? err.message : err)
    return false
  }
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await runMigrations()
    const date = tomorrowUtc()

    // Orders due tomorrow for restaurants with the reminder toggle ON, excluding
    // dead/cancelled/refunded/unpaid states. Total falls back to the Stripe
    // payment total (matching the other order surfaces).
    const orders = (await sql`
      SELECT o.id, o.reference, o.order_number, o.order_type, o.order_date, o.order_time,
             o.customer_email, o.customer_first_name, o.customer_last_name,
             o.subtotal, o.fee, o.tips, o.restaurant_reference, o.restaurant_name,
             COALESCE(NULLIF(o.total, 0),
               (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.total > 0)
             ) AS total
      FROM disco_orders o
      JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = o.restaurant_reference::text
      WHERE ov.order_reminder_emails_enabled = true
        AND o.order_date = ${date}::date
        AND o.is_deleted = false
        AND o.order_status NOT IN ('VOIDED','VOID','REFUNDED','REFUND','PARTIAL_REFUND','CANCELED','CANCELLED','EXPIRED','PAYMENT_FAILED','UNPAID','CART')
        AND o.customer_email IS NOT NULL AND o.customer_email <> ''
    `) as Array<{
      id: number; reference: string; order_number: string | number; order_type: string
      order_date: string; order_time: string; customer_email: string
      customer_first_name: string | null; customer_last_name: string | null
      subtotal: string | null; fee: string | null; tips: string | null; total: string | null
      restaurant_reference: string; restaurant_name: string | null
    }>

    let sent = 0
    let skipped = 0

    for (const o of orders) {
      // Idempotency guard — at most one reminder per order.
      const claimed = await claimReminder(o.reference)
      if (!claimed) { skipped++; continue }

      // Canonical restaurant name / phone / address from the cache.
      let cacheName = ''
      let cachePhone = ''
      let cacheAddress = ''
      try {
        const rc = (await sql`
          SELECT name, phone, address FROM disco_restaurant_cache WHERE restaurant_reference = ${o.restaurant_reference} LIMIT 1
        `) as { name: string | null; phone: string | null; address: string | null }[]
        cacheName = rc[0]?.name || ''
        cachePhone = rc[0]?.phone || ''
        cacheAddress = rc[0]?.address || ''
      } catch { /* best-effort */ }

      // Line items for the reminder body.
      const items = (await sql`
        SELECT name, quantity, price_per_unit FROM disco_order_items WHERE order_id = ${o.id} ORDER BY id
      `) as { name: string; quantity: number; price_per_unit: string }[]
      const orderMealPackages: OrderMealPackage[] = items.map((it) => ({
        count: num(it.quantity) || 1,
        name: String(it.name ?? ''),
        price: num(it.price_per_unit),
      }))

      const subtotal = num(o.subtotal)
      const totalPrice = num(o.total)
      const fees = num(o.fee)
      const tip = num(o.tips)

      const res = await sendCustomerOrderReminder({
        to: o.customer_email,
        firstName: o.customer_first_name || undefined,
        lastName: o.customer_last_name || undefined,
        orderService: String(o.order_type || ''),
        orderDate: fmtDate(o.order_date),
        orderTime: fmtTime(o.order_time),
        orderReceived: '',
        orderMealPackages,
        subtotal,
        fees,
        tip,
        totalPrice,
        orderNumber: o.order_number,
        businessName: cacheName || o.restaurant_name || 'the restaurant',
        businessPhone: cachePhone || undefined,
        addressLine1: cacheAddress || undefined,
      })
      if (res.success) sent++
    }

    return NextResponse.json({ ok: true, date, candidates: orders.length, sent, skipped })
  } catch (err) {
    console.error('[cron/order-reminders] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Reminder run failed' }, { status: 500 })
  }
}
