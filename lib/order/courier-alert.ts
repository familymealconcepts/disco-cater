// "Courier not booked": ONE #ops-alerts thread per order, keyed courier:<ref>.
//
// Before 2026-10-23 every failed attempt was its own post. Order 31086
// (#900000463) posted "dispatch FAILED" 61 times, once per 15-minute sweep, then
// AT RISK and MISSED as two more unrelated posts. Now the first failure opens the
// thread; at risk, missed and "Expedite will keep refusing" are replies in it (the
// first two also shown in the channel, because someone must act now); and the
// thread closes with ✅ when a courier is booked, the order is cancelled, or it is
// refunded.
//
// Once the delivery is MISSED, only a refund or partial refund closes it (Kevin,
// 2026-10-23): a cancelled or completed order with no courier still left a diner
// without their food, and a refund is the sign someone dealt with them.
import { sql } from '../db'
import { alertOnce, replyToAlert, resolveAlert, openAlertKeys } from '../ops-alert'
import { orderLink, shortError, money } from '../ops-alert-format'
import { orderFacts, orderLine } from '../ops-alert-facts'

export const courierKey = (reference: string) => `courier:${reference.trim().toLowerCase()}`

/** What Expedite last said about this order, in its own words ("Not operational in this region."). */
export async function lastExpediteRefusal(reference: string): Promise<string | null> {
  const rows = (await sql`
    SELECT response_body FROM disco_expedite_deliveries
     WHERE order_reference = ${reference}::uuid AND event = 'delivery_created' AND ok = false
     ORDER BY created_at DESC LIMIT 1
  `.catch(() => [])) as Array<{ response_body: string | null }>
  const body = String(rows[0]?.response_body ?? '').trim()
  if (!body) return null
  try {
    const m = (JSON.parse(body) as { message?: unknown }).message
    if (typeof m === 'string' && m.trim()) return shortError(m)
  } catch { /* not JSON */ }
  return shortError(body)
}

/**
 * Open the order's courier thread (a no-op while it is open). `what` is the
 * line saying why no courier was booked.
 */
export async function openCourierAlert(reference: string, what: string): Promise<boolean> {
  const f = await orderFacts(reference)
  const n = f?.orderNumber ?? null
  return alertOnce(courierKey(reference), {
    severity: 'urgent',
    headline: `Courier not booked — order ${n ? `#${n}` : reference}`,
    lines: [orderLine(f), `${what} Disco retries every 15 minutes until 20 minutes before pickup.`],
    action: "if it's still failing an hour before pickup, book a courier another way.",
    link: orderLink(reference, n),
    context: { reference, orderNumber: n, what },
  })
}

/** The line for a failed booking, quoting Expedite when it gave a reason. */
export async function expediteTurnedDownLine(reference: string, fallbackError?: string | null): Promise<string> {
  const said = await lastExpediteRefusal(reference)
  if (said) return `Expedite turned the booking down: "${said}"`
  return `Expedite turned the booking down${fallbackError ? ` (${shortError(fallbackError)})` : ''}.`
}

const clock = (at: string | Date, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at instanceof Date ? at : new Date(at))

/**
 * At risk / missed / refused. Replies in the order's thread; if nothing opened
 * a thread yet (the order never had a failed attempt — e.g. it was never sent
 * at all), the thread is opened first so the reply has somewhere to go.
 */
export async function escalateCourier(
  reference: string,
  step: 'at-risk' | 'missed' | 'refused',
  info: { minutesToPickup?: number; pickupAt?: string | null; refusal?: string | null },
): Promise<void> {
  const key = courierKey(reference)
  const open = await openAlertKeys(key)
  if (!open.includes(key)) {
    await openCourierAlert(reference, step === 'refused' && info.refusal
      ? `Expedite turned the booking down: "${info.refusal}"`
      : 'No courier was booked for this order.')
  }
  if (step === 'at-risk') {
    const m = Math.max(0, Math.round(info.minutesToPickup ?? 0))
    await replyToAlert(key, step, `Pickup is in ${m} minute${m === 1 ? '' : 's'} and there's still no courier.`, {
      broadcast: true, severity: 'warn', action: 'call the restaurant and the diner now.',
    })
  } else if (step === 'missed') {
    const f = await orderFacts(reference)
    const at = info.pickupAt ? `pickup was ${clock(info.pickupAt, f?.timeZone ?? 'America/New_York')}` : 'pickup time has passed'
    await replyToAlert(key, step, `Delivery missed: ${at} and no courier came.`, {
      broadcast: true, severity: 'urgent', action: 'call the diner, then refund or rebook.',
    })
  } else {
    await replyToAlert(key, step,
      `Expedite will keep refusing this order${info.refusal ? ` ("${info.refusal}")` : ''}, so Disco has stopped retrying.`,
      { action: 'arrange the delivery another way and take it up with Expedite.' })
  }
}

/** The retry booked one: close the thread with the fee. */
export async function courierBookedByRetry(reference: string, fee: string | null): Promise<boolean> {
  return resolveAlert(courierKey(reference),
    `Resolved: the 15-minute retry booked a courier${fee ? ` (fee ${money(fee)})` : ''}. The booking at checkout had failed, so it's worth finding out why.`)
}

/**
 * Close every open courier thread whose order no longer needs a courier.
 * Run on each sweep, before the scan, and whether or not dispatch is enabled.
 */
export async function resolveCourierAlerts(): Promise<number> {
  const keys = await openAlertKeys('courier:')
  if (!keys.length) return 0
  const refs = keys.map(k => k.slice('courier:'.length))
  const rows = (await sql`
    SELECT reference::text AS reference, order_status, expedite_delivery_id
      FROM disco_orders WHERE reference::text = ANY(${refs})
  `.catch(() => [])) as Array<{ reference: string; order_status: string | null; expedite_delivery_id: string | null }>
  const missed = new Set(((await sql`
    SELECT alert_key FROM disco_alert_dedup WHERE alert_key = ANY(${keys.map(k => `${k}#missed`)})
  `.catch(() => [])) as Array<{ alert_key: string }>).map(r => r.alert_key.replace(/#missed$/, '')))
  let closed = 0
  for (const r of rows) {
    const key = courierKey(r.reference)
    const status = String(r.order_status ?? '').toUpperCase()
    let text: string | null = null
    if (status === 'REFUND' || status === 'PARTIAL_REFUND') text = 'Resolved: the order was refunded.'
    else if (!missed.has(key)) {
      if (r.expedite_delivery_id && r.expedite_delivery_id !== 'PENDING') text = 'Resolved: a courier is booked.'
      else if (status === 'CANCELED' || status === 'CANCELLED' || status === 'VOIDED') text = 'Resolved: the order was cancelled.'
    }
    if (text && await resolveAlert(key, text)) closed++
  }
  return closed
}
