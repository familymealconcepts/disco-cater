// The facts an #ops-alerts message names about an order or a restaurant: number,
// restaurant name, when, amount. Call sites mostly hold only a reference, and an
// alert that says "orderReference c6b2af44-…" is the unreadable message this
// replaced. Best-effort: a failed lookup returns null and the caller falls back
// to what it has. Never throws.
import { sql } from './db'
import { formatWhen, money } from './ops-alert-format'

export type OrderFacts = {
  reference: string
  orderNumber: string
  restaurant: string
  restaurantReference: string | null
  timeZone: string
  total: number
  status: string
  orderType: string
  /** YYYY-MM-DD, the order's calendar day. */
  orderDate: string | null
  /** "Tue Oct 21, 8:30 AM PDT", or the bare day when the order has no time. */
  when: string
  customerEmail: string | null
  restaurantEmails: string[]
}

export async function orderFacts(ref: string | null | undefined): Promise<OrderFacts | null> {
  if (!ref) return null
  try {
    const rows = (await sql`
      SELECT o.reference::text AS reference, o.order_number::text AS order_number,
             COALESCE(o.restaurant_name, rc.name, '') AS restaurant,
             o.restaurant_reference::text AS restaurant_reference,
             COALESCE(NULLIF(rc.timezone, ''), 'America/New_York') AS tz,
             COALESCE(o.total, 0)::float AS total, COALESCE(o.order_status, '') AS status,
             COALESCE(o.order_type, '') AS order_type,
             to_char(o.order_date, 'YYYY-MM-DD') AS order_date,
             CASE WHEN o.order_date IS NOT NULL AND o.order_time IS NOT NULL
                  THEN (o.order_date + o.order_time) AT TIME ZONE COALESCE(NULLIF(rc.timezone, ''), 'America/New_York')
             END AS at,
             o.customer_email, o.restaurant_email, ov.notification_emails, ov.contact_email
        FROM disco_orders o
        LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
        LEFT JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = o.restaurant_reference::text
       WHERE o.reference::text = ${ref} OR o.fm_order_reference::text = ${ref}
       ORDER BY o.created_at DESC
       LIMIT 1`) as Array<{
        reference: string; order_number: string; restaurant: string; restaurant_reference: string | null; tz: string
        total: number; status: string; order_type: string; order_date: string | null; at: Date | string | null
        customer_email: string | null; restaurant_email: string | null; notification_emails: string | null; contact_email: string | null
      }>
    const r = rows[0]
    if (!r) return null
    const when = r.at ? formatWhen(r.at, r.tz) : r.order_date ? formatWhen(new Date(`${r.order_date}T12:00:00Z`), 'UTC', { dateOnly: true }) : ''
    return {
      reference: r.reference, orderNumber: r.order_number, restaurant: r.restaurant,
      restaurantReference: r.restaurant_reference, timeZone: r.tz, total: Number(r.total) || 0,
      status: r.status, orderType: String(r.order_type).toLowerCase(), orderDate: r.order_date, when,
      customerEmail: r.customer_email,
      restaurantEmails: [r.restaurant_email, r.notification_emails, r.contact_email]
        .flatMap(s => String(s ?? '').split(/[,;\s]+/)).map(s => s.trim()).filter(Boolean),
    }
  } catch (e) {
    console.error('[ops-alert-facts] order lookup failed (non-fatal):', e instanceof Error ? e.message : e)
    return null
  }
}

export async function restaurantName(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null
  try {
    const rows = (await sql`
      SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as Array<{ name: string | null }>
    return rows[0]?.name?.trim() || null
  } catch {
    return null
  }
}

/** "Apollo Bagels - Hoboken · delivery Mon Oct 20, 7:45 AM EDT · $74.78" */
export function orderLine(f: OrderFacts | null, opts?: { amount?: number | null; amountLabel?: string; when?: string | null; whenLabel?: string }): string {
  if (!f) return ''
  const parts = [f.restaurant || 'Unknown restaurant']
  // `when: null` means "no time on this line"; leaving it out means the order's own.
  const when = opts && 'when' in opts ? opts.when : f.when
  if (when) parts.push(`${opts?.whenLabel ?? (f.orderType === 'delivery' ? 'delivery' : 'for')} ${when}`)
  const amt = opts?.amount === undefined ? f.total : opts.amount
  if (amt != null) parts.push(`${opts?.amountLabel ? `${opts.amountLabel} ` : ''}${money(amt)}`)
  return parts.join(' · ')
}
