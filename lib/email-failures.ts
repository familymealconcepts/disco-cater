import { sql } from './db'
import { alertOps } from './ops-alert'

/**
 * ORDER EMAILS THAT MAILGUN COULD NOT DELIVER (Peter, 22 Oct 2026).
 *
 * Mailgun accepting an email is not the restaurant receiving it. On 20 Oct
 * Hugo's Studio City's new-order email for #900000499 ($420.63) was refused by
 * their mail server ("JunkMail rejected … is in an RBL") and nobody knew.
 *
 * Every few minutes the mailgun-failures cron reads Mailgun's PERMANENT
 * failures for mg.discocater.com, ties each to its order, records it once in
 * disco_email_failures (keyed on Mailgun's event id), and posts one ops alert
 * per new failure. Super Admin's Orders page shows the recorded failures on the
 * order.
 *
 * NEVER RESENDS. A resend to the same server from the same shared IP is
 * likely to be refused the same way, and a person has to decide whether to
 * phone the restaurant, use another address, or resend.
 *
 * Which order: the `v:order-number` user-variable every order email carries
 * (lib/email/send.ts), falling back to the order number in the subject for
 * mail sent before that variable existed. Emails that are not about an order
 * (password resets, invites) are ignored.
 */

type MgEvent = {
  id: string
  timestamp: number
  recipient?: string
  reason?: string
  severity?: string
  message?: { headers?: { subject?: string; 'message-id'?: string } }
  envelope?: { 'sending-ip'?: string }
  'delivery-status'?: { code?: number; message?: string; description?: string }
  'user-variables'?: Record<string, unknown>
}

export type EmailFailure = {
  eventId: string
  eventTime: string
  recipient: string
  subject: string
  reason: string
  sendingIp: string | null
  orderNumber: string
  orderReference: string | null
  restaurantReference: string | null
  restaurantName: string | null
}

let ensured = false
export async function ensureEmailFailures(): Promise<void> {
  if (ensured) return
  await sql`
    CREATE TABLE IF NOT EXISTS disco_email_failures (
      event_id TEXT PRIMARY KEY,           -- Mailgun's event id: one row, one alert, per failure
      event_time TIMESTAMPTZ NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT,
      reason TEXT,
      sending_ip TEXT,
      order_number TEXT NOT NULL,
      order_reference TEXT,                -- disco_orders.reference when the order was found
      restaurant_reference TEXT,
      restaurant_name TEXT,
      alerted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`CREATE INDEX IF NOT EXISTS idx_disco_email_failures_order ON disco_email_failures (order_number)`
  ensured = true
}

/** The order number an email is about, or null when it isn't an order email. */
export function orderNumberOf(ev: MgEvent): string | null {
  const v = ev['user-variables']?.['order-number']
  if (v != null && /^\d{3,}$/.test(String(v).trim())) return String(v).trim()
  const subject = ev.message?.headers?.subject || ''
  const m = /\border\b[^#\d]{0,3}#?\s*(\d{5,})/i.exec(subject) || /#\s*(\d{5,})/.exec(subject)
  return m ? m[1] : null
}

function reasonOf(ev: MgEvent): string {
  const ds = ev['delivery-status'] || {}
  const text = String(ds.message || ds.description || ev.reason || 'unknown').replace(/\s+/g, ' ').replace(/^"|"$/g, '').trim()
  return ds.code ? `${ds.code} ${text}` : text
}

async function fetchPermanentFailures(sinceSec: number): Promise<MgEvent[]> {
  const key = process.env.MAILGUN_API_KEY
  const domain = process.env.MAILGUN_DOMAIN
  if (!key || !domain) throw new Error('MAILGUN_API_KEY / MAILGUN_DOMAIN not set')
  const auth = 'Basic ' + Buffer.from(`api:${key}`).toString('base64')
  const out: MgEvent[] = []
  let url: string | null = `https://api.mailgun.net/v3/${domain}/events?` + new URLSearchParams({
    event: 'failed', severity: 'permanent', begin: String(Math.floor(sinceSec)), ascending: 'yes', limit: '300',
  })
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: auth } })
    if (!res.ok) throw new Error(`Mailgun events ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const j = (await res.json()) as { items?: MgEvent[]; paging?: { next?: string } }
    const items = j.items || []
    out.push(...items)
    url = items.length ? (j.paging?.next || null) : null
  }
  return out
}

/** Find the order: same number, preferring the restaurant named in the subject, then the recipient as customer, then the newest. */
async function matchOrder(orderNumber: string, subject: string, recipient: string) {
  const rows = (await sql`
    SELECT o.reference::text AS reference, o.restaurant_reference::text AS restaurant_reference,
           COALESCE(o.restaurant_name, rc.name) AS restaurant_name, lower(coalesce(o.customer_email,'')) AS customer_email
      FROM disco_orders o
      LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
     WHERE o.order_number::text = ${orderNumber}
     ORDER BY o.created_at DESC
     LIMIT 20`) as Array<{ reference: string; restaurant_reference: string; restaurant_name: string | null; customer_email: string }>
  if (!rows.length) return null
  const subj = subject.toLowerCase()
  const score = (r: typeof rows[number]) =>
    (r.restaurant_name && subj.includes(r.restaurant_name.toLowerCase()) ? 2 : 0) + (r.customer_email === recipient.toLowerCase() ? 1 : 0)
  return rows.reduce((best, r) => (score(r) > score(best) ? r : best), rows[0])
}

/**
 * Record and alert every permanent order-email failure since `lookbackHours`
 * ago. Safe to run as often as wanted: an event already recorded is skipped.
 */
export async function checkEmailFailures(lookbackHours = 2): Promise<{ scanned: number; orderEmails: number; recorded: EmailFailure[] }> {
  await ensureEmailFailures()
  const events = await fetchPermanentFailures(Date.now() / 1000 - lookbackHours * 3600)
  const recorded: EmailFailure[] = []
  let orderEmails = 0
  for (const ev of events) {
    const orderNumber = orderNumberOf(ev)
    if (!orderNumber || !ev.id) continue
    orderEmails++
    const recipient = String(ev.recipient || '').trim()
    const subject = String(ev.message?.headers?.subject || '')
    const order = await matchOrder(orderNumber, subject, recipient)
    const f: EmailFailure = {
      eventId: ev.id,
      eventTime: new Date(ev.timestamp * 1000).toISOString(),
      recipient,
      subject,
      reason: reasonOf(ev),
      sendingIp: ev.envelope?.['sending-ip'] || null,
      orderNumber,
      orderReference: order?.reference || null,
      restaurantReference: order?.restaurant_reference || null,
      restaurantName: order?.restaurant_name || null,
    }
    const inserted = (await sql`
      INSERT INTO disco_email_failures (event_id, event_time, recipient, subject, reason, sending_ip, order_number, order_reference, restaurant_reference, restaurant_name)
      VALUES (${f.eventId}, ${f.eventTime}, ${f.recipient}, ${f.subject}, ${f.reason}, ${f.sendingIp}, ${f.orderNumber}, ${f.orderReference}, ${f.restaurantReference}, ${f.restaurantName})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id`) as unknown[]
    if (!inserted.length) continue
    await alertOps(`Order email NOT delivered — order #${f.orderNumber}${f.restaurantName ? ` (${f.restaurantName})` : ''} to ${f.recipient}. Not resent; someone needs to contact them.`, {
      reason: f.reason, subject: f.subject, sendingIp: f.sendingIp, failedAt: f.eventTime, orderFound: !!f.orderReference,
    })
    await sql`UPDATE disco_email_failures SET alerted_at = NOW() WHERE event_id = ${f.eventId}`
    recorded.push(f)
  }
  return { scanned: events.length, orderEmails, recorded }
}

export type OrderEmailFailure = { recipient: string; reason: string; eventTime: string; subject: string | null }

/** Recorded failures for these order numbers, keyed by order number, each tagged with its restaurant for matching. */
export async function emailFailuresFor(orderNumbers: string[]): Promise<Map<string, Array<OrderEmailFailure & { restaurantReference: string | null; restaurantName: string | null }>>> {
  const out = new Map<string, Array<OrderEmailFailure & { restaurantReference: string | null; restaurantName: string | null }>>()
  const nums = Array.from(new Set(orderNumbers.filter(Boolean)))
  if (!nums.length) return out
  try {
    await ensureEmailFailures()
    const rows = (await sql`
      SELECT order_number, recipient, reason, event_time, subject, restaurant_reference, restaurant_name
        FROM disco_email_failures WHERE order_number = ANY(${nums}::text[]) ORDER BY event_time`) as Array<Record<string, unknown>>
    for (const r of rows) {
      const k = String(r.order_number)
      if (!out.has(k)) out.set(k, [])
      out.get(k)!.push({
        recipient: String(r.recipient), reason: String(r.reason || ''), subject: (r.subject as string) || null,
        eventTime: new Date(r.event_time as string).toISOString(),
        restaurantReference: (r.restaurant_reference as string) || null, restaurantName: (r.restaurant_name as string) || null,
      })
    }
  } catch (e) {
    console.error('[email-failures] lookup failed (non-fatal):', e instanceof Error ? e.message : e)
  }
  return out
}
