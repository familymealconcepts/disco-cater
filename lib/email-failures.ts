import { sql } from './db'
import { alertOnce, openAlertKeys, resolveAlert } from './ops-alert'
import { emailSide, maskDinerEmail, bounceReason, orderLink, formatDay, type OpsAlert } from './ops-alert-format'
import { orderFacts, orderLine } from './ops-alert-facts'

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
 * The default covers Mailgun's whole ~3-day retention, so a missed or failed
 * cron run catches up on the next one instead of losing failures.
 */
export async function checkEmailFailures(lookbackHours = 72): Promise<{ scanned: number; orderEmails: number; recorded: EmailFailure[] }> {
  await ensureEmailFailures()
  const events = await fetchPermanentFailures(Date.now() / 1000 - lookbackHours * 3600)
  const recorded: EmailFailure[] = []
  let orderEmails = 0
  for (const ev of events) {
    const orderNumber = orderNumberOf(ev)
    if (!orderNumber || !ev.id) continue
    orderEmails++
    const seen = (await sql`SELECT 1 FROM disco_email_failures WHERE event_id = ${ev.id}`) as unknown[]
    if (seen.length) continue
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
    const alert = await emailFailureAlert(f)
    await alertOnce(`email:${(f.orderReference ?? `n${f.orderNumber}`).toLowerCase()}:${String(alert.context?.side ?? 'unknown')}`, alert)
    await sql`UPDATE disco_email_failures SET alerted_at = NOW() WHERE event_id = ${f.eventId}`
    recorded.push(f)
  }
  await resolvePastEmailAlerts()
  return { scanned: events.length, orderEmails, recorded }
}

// ── The #ops-alerts message (approved word for word, Kevin 2026-10-23) ────────
// One thread per order AND side: a second bounce of the same copy is silent
// (#900000571 posted twice before this). Which side bounced is decided by
// emailSide() in lib/ops-alert-format.ts — subject first, recipient second.
// A diner's address is shown as …@domain only; a restaurant's in full.

export async function emailFailureAlert(f: EmailFailure): Promise<OpsAlert> {
  const facts = await orderFacts(f.orderReference)
  const side = emailSide({
    subject: f.subject, recipient: f.recipient, orderNumber: f.orderNumber,
    customerEmail: facts?.customerEmail, restaurantEmails: facts?.restaurantEmails,
  })
  const shown = side === 'restaurant' ? f.recipient : maskDinerEmail(f.recipient)
  const sent = `Sent to ${shown}. ${bounceReason(f.reason, f.recipient)} Not resent.`
  const who = orderLine(facts, side === 'restaurant'
    ? { amount: facts?.total, whenLabel: 'order for' }
    : { amount: null, whenLabel: 'order for', when: formatDay(facts?.orderDate) })
    || (f.restaurantName ?? '')
  const link = f.orderReference ? orderLink(f.orderReference, f.orderNumber) : undefined
  const context = { eventId: f.eventId, side, reason: f.reason, subject: f.subject, failedAt: f.eventTime }
  if (side === 'diner') {
    return {
      severity: 'email', headline: `Diner didn't get their order receipt — #${f.orderNumber}`,
      lines: [who, sent],
      action: 'contact the diner to confirm the order, then resend the receipt to the right address from Admin › Manage Customers.',
      link, context,
    }
  }
  if (side === 'restaurant') {
    return {
      severity: 'email', headline: `Restaurant didn't get the new-order email — #${f.orderNumber}`,
      lines: [who, sent],
      action: 'call the restaurant to make sure they have the order.',
      link, context,
    }
  }
  return {
    severity: 'email', headline: `Order email bounced — #${f.orderNumber}`,
    lines: [who, sent, "Couldn't tell whether this was the diner's or the restaurant's copy."],
    action: 'call the restaurant to make sure they have the order, and check the diner has their receipt.',
    link, context,
  }
}

/**
 * Close the thread the day after the order date ends, in the restaurant's zone
 * (Kevin, 2026-10-23): by then there is nothing left to do for that order.
 */
async function resolvePastEmailAlerts(): Promise<void> {
  const keys = await openAlertKeys('email:')
  if (!keys.length) return
  const refs = Array.from(new Set(keys.map(k => k.split(':')[1]).filter(r => /^[0-9a-f-]{36}$/.test(r))))
  if (!refs.length) return
  const past = (await sql`
    SELECT o.reference::text AS reference
      FROM disco_orders o
      LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
     WHERE o.reference::text = ANY(${refs})
       AND ((o.order_date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(rc.timezone, ''), 'America/New_York')) <= NOW()
  `.catch(() => [])) as Array<{ reference: string }>
  const done = new Set(past.map(r => r.reference.toLowerCase()))
  for (const k of keys) {
    if (done.has(k.split(':')[1])) await resolveAlert(k, 'The order date has passed, so this is closed.')
  }
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
