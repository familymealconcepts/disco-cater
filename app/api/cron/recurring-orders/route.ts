// Daily cron for Disco-managed recurring orders. Runs at 09:00 UTC (see
// vercel.json) and performs three time-based passes over occurrence rows:
//
//   TASK A — 5-day reminders   (scheduled_date = today + 5)
//   TASK B — auto-charge        (scheduled_date = today + 2, i.e. 48h out)
//   TASK C — cancel unpaid      (scheduled_date = today + 1, past the 48h cutoff)
//   TASK D — menu availability  (active orders with an occurrence in next 7 days)
//
// REQUIRED ENV (set in Vercel → Project → Environment Variables):
//   CRON_SECRET      shared secret. Vercel Cron sends it as
//                    `Authorization: Bearer ${CRON_SECRET}`; also accepted for
//                    manual/CLI calls.
//   MAILGUN_API_KEY  Mailgun private API key (Basic auth: api:{key}).
//   MAILGUN_DOMAIN   Mailgun sending domain.
// When Mailgun is unconfigured the cron still runs and updates DB statuses —
// it just logs a warning and skips the emails.

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql } from '../../../../lib/db'
import { checkMenuAvailability, repriceCart, type CartItem } from '../../../../lib/recurring'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
const FROM = 'Disco Cater <concierge@discocater.com>'
const RESTAURANT_NOTIFY_EMAIL = 'concierge@discocater.com'
const APP_URL = 'https://www.discocater.com'

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

// ── Date helpers (all UTC, matching the DATE column semantics) ───────────────

function todayUTC(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function addDays(base: Date, n: number): Date {
  return new Date(base.getTime() + n * 86_400_000)
}
function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}
// Shift a 'YYYY-MM-DD' string by N days, returning a new 'YYYY-MM-DD'.
function shiftISO(dateISO: string, n: number): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  return toISO(addDays(new Date(Date.UTC(y, m - 1, d)), n))
}
// "Wednesday, June 11, 2026"
function fmtLong(dateISO?: string | null): string {
  if (!dateISO) return ''
  const [y, m, d] = dateISO.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}
// "12:30 PM" — occurrences may carry no time (null), so fall back gracefully.
function fmtTime(t?: string | null): string {
  if (!t) return 'your scheduled time'
  const [h, m] = t.split(':').map(Number)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ampm}`
}

// Neon may hand back DATE columns as a Date or as a 'YYYY-MM-DD' string
// depending on driver/runtime — normalize to the ISO string we compare on.
function normDate(v: unknown): string {
  if (v instanceof Date) return toISO(v)
  return String(v).slice(0, 10)
}

// ── Email (Mailgun HTTP API — mirrors become-a-partner/menu-upload) ─────────

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.warn('[cron/recurring-orders] Mailgun not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN) — skipping email:', subject)
    return false
  }
  if (!to) {
    console.warn('[cron/recurring-orders] no recipient for email:', subject)
    return false
  }
  try {
    const mg = new FormData()
    mg.append('from', FROM)
    mg.append('to', to)
    mg.append('subject', subject)
    mg.append('text', text)
    mg.append('html', html)
    const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
      body: mg,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error(`[cron/recurring-orders] Mailgun ${res.status} for "${subject}": ${raw.slice(0, 300)}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[cron/recurring-orders] send failed for "${subject}":`, err)
    return false
  }
}

// Minimal branded HTML shell.
function layout(inner: string): string {
  return `<div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1A1028;line-height:1.6;font-size:15px">
  <div style="font-size:22px;font-weight:700;margin-bottom:18px">
    <span style="background:linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%);-webkit-background-clip:text;background-clip:text;color:transparent">disco</span><span style="color:#999"> cater</span>
  </div>
  ${inner}
  <p style="margin-top:24px;color:#888;font-size:13px">— The Disco Cater Team</p>
</div>`
}
function button(label: string, href: string): string {
  return `<p style="margin:22px 0"><a href="${href}" style="display:inline-block;background:#5B6FE8;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;font-size:14px">${label}</a></p>`
}

// ── Email templates ──────────────────────────────────────────────────────────

function emailReminder(firstName: string, restaurantName: string, dateISO: string, time: string, chargeISO: string, modifyISO: string) {
  const subject = `Your recurring catering order from ${restaurantName} is coming up`
  const date = fmtLong(dateISO)
  const chargeDate = fmtLong(chargeISO)
  const modifyDeadline = fmtLong(modifyISO)
  const html = layout(`
    <p>Hi ${firstName || 'there'},</p>
    <p>Your recurring catering order from <strong>${restaurantName}</strong> is scheduled for <strong>${date}</strong> at ${time}.</p>
    <p>Your saved card will be automatically charged 48 hours before your order (on <strong>${chargeDate}</strong>).</p>
    <p>Want to make changes? Log in to modify your order before <strong>${modifyDeadline}</strong> (48 hours before your order).</p>
    ${button('Manage your recurring orders', `${APP_URL}/account/subscriptions`)}
    <p>If you'd like to pause or cancel, you can do so from your subscriptions page before ${chargeDate}.</p>
  `)
  const text = `Hi ${firstName || 'there'},

Your recurring catering order from ${restaurantName} is scheduled for ${date} at ${time}.

Your saved card will be automatically charged 48 hours before your order (on ${chargeDate}).

Want to make changes? Log in to modify your order before ${modifyDeadline} (48 hours before your order).

Manage your recurring orders: ${APP_URL}/account/subscriptions

If you'd like to pause or cancel, you can do so from your subscriptions page before ${chargeDate}.

— The Disco Cater Team`
  return { subject, html, text }
}

function emailPaymentNeeded(firstName: string, restaurantName: string, dateISO: string, deadlineISO: string, needsNewCard = false) {
  const subject = `Action required: Payment needed for your catering order from ${restaurantName}`
  const date = fmtLong(dateISO)
  const deadline = fmtLong(deadlineISO)
  const cardNoteHtml = needsNewCard
    ? `<p>Your bank requires you to re-confirm this card. Please <strong>update your payment method</strong> on your subscriptions page so we can charge it automatically.</p>`
    : ''
  const cardNoteText = needsNewCard
    ? `\nYour bank requires you to re-confirm this card. Please update your payment method on your subscriptions page so we can charge it automatically.\n`
    : ''
  const html = layout(`
    <p>Hi ${firstName || 'there'},</p>
    <p>We were unable to automatically charge your card for your upcoming catering order from <strong>${restaurantName}</strong> on <strong>${date}</strong>.</p>
    ${cardNoteHtml}
    <p>Please log in and complete payment before <strong>${deadline}</strong> to keep your order.</p>
    ${button('Complete payment', `${APP_URL}/account/subscriptions`)}
    <p>If payment is not received by ${deadline}, your order will be automatically canceled.</p>
  `)
  const text = `Hi ${firstName || 'there'},

We were unable to automatically charge your card for your upcoming catering order from ${restaurantName} on ${date}.
${cardNoteText}
Please log in and complete payment before ${deadline} to keep your order.

Complete payment: ${APP_URL}/account/subscriptions

If payment is not received by ${deadline}, your order will be automatically canceled.

— The Disco Cater Team`
  return { subject, html, text }
}

// Internal alert to concierge: a charge succeeded but the FM order couldn't be
// placed automatically, so it needs manual fulfillment (do NOT refund).
function emailManualReview(o: {
  restaurantName: string; restaurantReference: string; customerName: string; customerEmail: string
  dateISO: string; amount: number; paymentIntentId: string; occurrenceId: string; reason: string
  cart: CartItem[]
}) {
  const subject = `Manual placement needed — ${o.restaurantName} on ${fmtLong(o.dateISO)} (charged $${o.amount.toFixed(2)})`
  const items = (o.cart || []).map(i => `  - ${i.name} ×${i.quantity ?? 1}`).join('\n') || '  (no items recorded)'
  const text = `A recurring-order charge SUCCEEDED but the order could NOT be placed automatically. Do not refund — place the order manually.

Restaurant: ${o.restaurantName} (${o.restaurantReference})
Customer: ${o.customerName || '—'} (${o.customerEmail || '—'})
Order date: ${fmtLong(o.dateISO)}
Amount charged: $${o.amount.toFixed(2)}
Stripe PaymentIntent: ${o.paymentIntentId}
Occurrence: ${o.occurrenceId}
Reason placement failed: ${o.reason}

Items:
${items}`
  const html = layout(`
    <p><strong>A recurring-order charge succeeded but the order could not be placed automatically.</strong> Do not refund — place the order manually.</p>
    <p>
      <strong>Restaurant:</strong> ${o.restaurantName} (${o.restaurantReference})<br/>
      <strong>Customer:</strong> ${o.customerName || '—'} (${o.customerEmail || '—'})<br/>
      <strong>Order date:</strong> ${fmtLong(o.dateISO)}<br/>
      <strong>Amount charged:</strong> $${o.amount.toFixed(2)}<br/>
      <strong>Stripe PaymentIntent:</strong> ${o.paymentIntentId}<br/>
      <strong>Occurrence:</strong> ${o.occurrenceId}<br/>
      <strong>Reason placement failed:</strong> ${o.reason}
    </p>
    <p><strong>Items:</strong><br/>${(o.cart || []).map(i => `${i.name} ×${i.quantity ?? 1}`).join('<br/>') || '(no items recorded)'}</p>
  `)
  return { subject, html, text }
}

function emailCanceledCustomer(firstName: string, restaurantName: string, dateISO: string, nextOrderISO: string | null) {
  const subject = `Your catering order from ${restaurantName} has been canceled`
  const date = fmtLong(dateISO)
  const nextLine = nextOrderISO
    ? `Your recurring order schedule remains active — your next order is scheduled for <strong>${fmtLong(nextOrderISO)}</strong>.`
    : `Your recurring order schedule remains active.`
  const nextLineText = nextOrderISO
    ? `Your recurring order schedule remains active — your next order is scheduled for ${fmtLong(nextOrderISO)}.`
    : `Your recurring order schedule remains active.`
  const html = layout(`
    <p>Hi ${firstName || 'there'},</p>
    <p>Unfortunately, your catering order from <strong>${restaurantName}</strong> scheduled for <strong>${date}</strong> has been canceled because payment was not received 48 hours before the order date.</p>
    <p>${nextLine}</p>
    <p>To ensure future orders are fulfilled, please make sure you have a valid payment card saved in your account.</p>
    ${button('Add payment card', `${APP_URL}/account/payment`)}
  `)
  const text = `Hi ${firstName || 'there'},

Unfortunately, your catering order from ${restaurantName} scheduled for ${date} has been canceled because payment was not received 48 hours before the order date.

${nextLineText}

To ensure future orders are fulfilled, please make sure you have a valid payment card saved in your account.

Add payment card: ${APP_URL}/account/payment

— The Disco Cater Team`
  return { subject, html, text }
}

function emailCanceledRestaurant(restaurantName: string, firstName: string, lastName: string, email: string, dateISO: string) {
  const subject = `Recurring order canceled — ${restaurantName} on ${fmtLong(dateISO)}`
  const date = fmtLong(dateISO)
  const text = `A recurring order has been automatically canceled due to non-payment.

Restaurant: ${restaurantName}
Customer: ${[firstName, lastName].filter(Boolean).join(' ') || '—'} (${email || '—'})
Order date: ${date}
Cancellation reason: Payment not received 48 hours before order`
  const html = layout(`
    <p>A recurring order has been automatically canceled due to non-payment.</p>
    <p>
      <strong>Restaurant:</strong> ${restaurantName}<br/>
      <strong>Customer:</strong> ${[firstName, lastName].filter(Boolean).join(' ') || '—'} (${email || '—'})<br/>
      <strong>Order date:</strong> ${date}<br/>
      <strong>Cancellation reason:</strong> Payment not received 48 hours before order
    </p>
  `)
  return { subject, html, text }
}

function emailMenuPaused(firstName: string, restaurantName: string, unavailableItems: string[]) {
  const subject = `Your recurring order from ${restaurantName} has been paused`
  const list = unavailableItems.join(', ') || 'one or more items'
  const html = layout(`
    <p>Hi ${firstName || 'there'},</p>
    <p>Some items in your recurring order are no longer available: <strong>${list}</strong>. Your order has been paused.</p>
    <p>Please update your order to resume.</p>
    ${button('Update your order', `${APP_URL}/account/subscriptions`)}
  `)
  const text = `Hi ${firstName || 'there'},

Some items in your recurring order are no longer available: ${list}. Your order has been paused.

Please update your order at ${APP_URL}/account/subscriptions to resume.

— The Disco Cater Team`
  return { subject, html, text }
}

// ── Joined occurrence row (occurrence + its parent recurring order) ─────────

interface OccRow {
  id: string
  recurring_order_id: string
  scheduled_date: string
  scheduled_time: string | null
  status: string
  customer_email: string
  customer_first_name: string | null
  customer_last_name: string | null
  restaurant_name: string
  source_order_reference: string
}

// Active occurrences due on a specific date with the given occurrence statuses.
async function dueOccurrences(dateISO: string, statuses: string[]): Promise<OccRow[]> {
  const rows = (await sql`
    SELECT o.id, o.recurring_order_id, o.scheduled_date, o.scheduled_time, o.status,
           r.customer_email, r.customer_first_name, r.customer_last_name,
           r.restaurant_name, r.source_order_reference
    FROM recurring_order_occurrences o
    JOIN recurring_orders r ON r.id = o.recurring_order_id
    WHERE o.scheduled_date = ${dateISO}::date
      AND r.status = 'ACTIVE'
      AND o.status = ANY(${statuses})
    ORDER BY o.scheduled_date ASC
  `) as OccRow[]
  return rows
}

// The next still-live occurrence after a given date for one recurring order.
async function nextOccurrenceDate(recurringOrderId: string, afterISO: string): Promise<string | null> {
  const rows = (await sql`
    SELECT scheduled_date FROM recurring_order_occurrences
    WHERE recurring_order_id = ${recurringOrderId}
      AND scheduled_date > ${afterISO}::date
      AND status NOT IN ('CANCELED', 'SKIPPED')
    ORDER BY scheduled_date ASC
    LIMIT 1
  `) as { scheduled_date: string }[]
  return rows[0] ? normDate(rows[0].scheduled_date) : null
}

// ── Charge pass (TASK B) helpers ─────────────────────────────────────────────

interface ChargeRow {
  id: string
  recurring_order_id: string
  scheduled_date: string
  scheduled_time: string | null
  status: string
  cart_snapshot: CartItem[] | null
  customer_email: string
  customer_first_name: string | null
  customer_last_name: string | null
  restaurant_name: string
  restaurant_reference: string
  stripe_customer_id: string | null
  stripe_payment_method_id: string | null
  source_order_total: string | number | null
}

// Occurrences due for auto-charge (48h out) on an ACTIVE recurring order, with
// the Stripe identity + amount fields needed to charge.
async function chargeableOccurrences(dateISO: string): Promise<ChargeRow[]> {
  return (await sql`
    SELECT o.id, o.recurring_order_id, o.scheduled_date, o.scheduled_time, o.status, o.cart_snapshot,
           r.customer_email, r.customer_first_name, r.customer_last_name,
           r.restaurant_name, r.restaurant_reference,
           r.stripe_customer_id, r.stripe_payment_method_id, r.source_order_total
    FROM recurring_order_occurrences o
    JOIN recurring_orders r ON r.id = o.recurring_order_id
    WHERE o.scheduled_date = ${dateISO}::date
      AND r.status = 'ACTIVE'
      AND o.status = ANY(${['REMINDER_SENT', 'SCHEDULED']})
    ORDER BY o.scheduled_date ASC
  `) as ChargeRow[]
}

// Charge amount in dollars: sum of the occurrence cart's per-item pricing,
// falling back to the recurring order's stored source-order total.
function computeAmount(cart: CartItem[] | null, sourceTotal: string | number | null): number {
  let sum = 0
  let hasPrice = false
  for (const it of cart || []) {
    if (typeof it.price === 'number') { hasPrice = true; sum += it.price * (it.quantity || 1) }
  }
  if (hasPrice && sum > 0) return sum
  const t = sourceTotal == null ? 0 : parseFloat(String(sourceTotal))
  return Number.isFinite(t) ? t : 0
}

// Place the FM order for a charged occurrence using the Direct Entry pattern
// (system-placed → sourceoforder FAMILYMEAL). Returns the FM order reference.
//
// Direct Entry requires an authenticated restaurant FM session
// (getRestaurantAuthHeader, cookie-based). The Vercel cron has no such session,
// so this throws there and the caller routes the (already-charged) occurrence to
// the manual-review path. The init draft is created via the public endpoint; the
// authenticated finalize/place steps run only when a restaurant session exists.
async function placeFmOrder(restaurantRef: string, cart: CartItem[], scheduledDateISO: string): Promise<string> {
  const authHeaders = await getRestaurantAuthHeader() // throws "Not authenticated" in cron

  // Draft (public-api init) — mirrors /api/order/init.
  const initRes = await fetch(`${FM_API}/public-api/v2/restaurants/${restaurantRef}/orders/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      localDate: scheduledDateISO,
      orderMealPackages: (cart || []).map(i => ({ name: i.name, count: i.quantity || 1, price: i.price })),
    }),
  })
  if (!initRes.ok) throw new Error(`FM init ${initRes.status}`)
  const draft = await initRes.json().catch(() => ({}))
  const orderRef: string | undefined = draft?.orderReference || draft?.reference
  if (!orderRef) throw new Error('FM init returned no order reference')

  // Place (authenticated). Direct Entry attribution.
  const placeRes = await fetch(`${FM_API}/api/v2/restaurants/${restaurantRef}/orders/${orderRef}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sourceoforder: 'FAMILYMEAL' }),
  })
  if (!placeRes.ok) throw new Error(`FM place ${placeRes.status}`)
  return orderRef
}

// ── Cron handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const base = todayUTC()
  const plus7 = toISO(addDays(base, 7))
  const plus5 = toISO(addDays(base, 5))
  const plus2 = toISO(addDays(base, 2))
  const plus1 = toISO(addDays(base, 1))
  const todayISO = toISO(base)

  const errors: string[] = []
  let remindersSent = 0
  let chargesSucceeded = 0
  let chargesFailed = 0
  let ordersPlaced = 0
  let manualReview = 0
  let cancellations = 0
  let menuPauses = 0

  const stripeKey = process.env.STRIPE_SECRET_KEY
  // The SDK pins apiVersion to its own literal; cast so we can request the
  // version this integration was written against without hardcoding the SDK's.
  const stripe = stripeKey
    ? new Stripe(stripeKey, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
    : null

  // ── TASK A — 5-day reminders ───────────────────────────────────────────────
  try {
    const due = await dueOccurrences(plus5, ['SCHEDULED'])
    for (const occ of due) {
      try {
        const date = normDate(occ.scheduled_date)
        const chargeISO = shiftISO(date, -2)   // auto-charge happens 48h before
        const { subject, html, text } = emailReminder(
          occ.customer_first_name || '', occ.restaurant_name, date, fmtTime(occ.scheduled_time), chargeISO, chargeISO,
        )
        await sendEmail(occ.customer_email, subject, html, text)
        await sql`
          UPDATE recurring_order_occurrences
          SET status = 'REMINDER_SENT', updated_at = NOW()
          WHERE id = ${occ.id}
        `
        remindersSent++
      } catch (e) {
        errors.push(`reminder ${occ.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    errors.push(`TASK A: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── TASK B — auto-charge 48h before via Stripe (off-session) ───────────────
  try {
    // Includes SCHEDULED as well as REMINDER_SENT in case the reminder pass was
    // ever missed for this occurrence.
    const due = await chargeableOccurrences(plus2)
    for (const occ of due) {
      try {
        const date = normDate(occ.scheduled_date)
        // Cancellation cutoff is 24h after this attempt (scheduled_date - 1).
        const deadlineISO = shiftISO(date, -1)
        const firstName = occ.customer_first_name || ''

        // No Stripe identity on file (or Stripe unconfigured) → can't auto-charge.
        if (!stripe || !occ.stripe_customer_id || !occ.stripe_payment_method_id) {
          await sql`
            UPDATE recurring_order_occurrences
            SET status = 'CHARGE_FAILED', charge_failed_at = NOW(), updated_at = NOW()
            WHERE id = ${occ.id}
          `
          const m = emailPaymentNeeded(firstName, occ.restaurant_name, date, deadlineISO, true)
          await sendEmail(occ.customer_email, m.subject, m.html, m.text)
          chargesFailed++
          continue
        }

        // Re-price the cart against the CURRENT menu before charging (I5), so a
        // menu price change since setup is reflected. Falls back to the snapshot
        // prices on any fetch issue, so a transient error never mis-charges.
        const repricedCart = await repriceCart(occ.restaurant_reference, occ.cart_snapshot || []).catch(() => occ.cart_snapshot || [])
        const amount = computeAmount(repricedCart, occ.source_order_total)
        if (amount <= 0) {
          await sql`
            UPDATE recurring_order_occurrences
            SET status = 'CHARGE_FAILED', charge_failed_at = NOW(), updated_at = NOW()
            WHERE id = ${occ.id}
          `
          const m = emailPaymentNeeded(firstName, occ.restaurant_name, date, deadlineISO)
          await sendEmail(occ.customer_email, m.subject, m.html, m.text)
          chargesFailed++
          continue
        }

        // ── Atomic claim before charging ────────────────────────────────────
        // Flip the occurrence out of the chargeable set (REMINDER_SENT/SCHEDULED)
        // to CHARGE_ATTEMPTED in a single conditional UPDATE, and only proceed if
        // THIS run won the claim. Without it, a crash/timeout between the Stripe
        // charge and the status write — or two overlapping hourly runs — would
        // re-select the same occurrence and charge the card again.
        const claim = (await sql`
          UPDATE recurring_order_occurrences
          SET status = 'CHARGE_ATTEMPTED', charge_attempted_at = NOW(), updated_at = NOW()
          WHERE id = ${occ.id} AND status = ANY(${['REMINDER_SENT', 'SCHEDULED']})
          RETURNING id
        `) as { id: number }[]
        if (!claim.length) {
          // Another concurrent run already claimed/charged this occurrence.
          continue
        }

        // ── Off-session charge ──────────────────────────────────────────────
        // idempotencyKey is stable per occurrence, so even if this occurrence were
        // ever retried at Stripe, the same PaymentIntent is returned instead of a
        // second charge (belt-and-suspenders alongside the claim above).
        let paymentIntent: Stripe.PaymentIntent
        try {
          paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // dollars → cents
            currency: 'usd',
            customer: occ.stripe_customer_id,
            payment_method: occ.stripe_payment_method_id,
            off_session: true,
            confirm: true,
            description: `Recurring catering order - ${occ.restaurant_name}`,
            metadata: {
              recurring_order_id: occ.recurring_order_id,
              occurrence_id: occ.id,
              customer_email: occ.customer_email,
            },
          }, { idempotencyKey: `recurring-occ-${occ.id}` })
        } catch (stripeErr) {
          // Card declined / authentication_required / etc.
          const code = (stripeErr as Stripe.StripeRawError)?.code
          await sql`
            UPDATE recurring_order_occurrences
            SET status = 'CHARGE_FAILED', charge_failed_at = NOW(), updated_at = NOW()
            WHERE id = ${occ.id}
          `
          const m = emailPaymentNeeded(firstName, occ.restaurant_name, date, deadlineISO, code === 'authentication_required')
          await sendEmail(occ.customer_email, m.subject, m.html, m.text)
          chargesFailed++
          continue
        }

        if (paymentIntent.status !== 'succeeded') {
          // requires_action / requires_payment_method / etc. — treat as failed.
          await sql`
            UPDATE recurring_order_occurrences
            SET status = 'CHARGE_FAILED', charge_failed_at = NOW(),
                stripe_payment_intent_id = ${paymentIntent.id}, updated_at = NOW()
            WHERE id = ${occ.id}
          `
          const m = emailPaymentNeeded(firstName, occ.restaurant_name, date, deadlineISO, paymentIntent.status === 'requires_action')
          await sendEmail(occ.customer_email, m.subject, m.html, m.text)
          chargesFailed++
          continue
        }

        // Charge succeeded → record it (order placement pending). NOTE: TASK C
        // intentionally does NOT cancel CHARGE_ATTEMPTED, so a charged-but-
        // unplaced occurrence is never auto-canceled out from under the customer.
        await sql`
          UPDATE recurring_order_occurrences
          SET status = 'CHARGE_ATTEMPTED', charge_attempted_at = NOW(),
              stripe_payment_intent_id = ${paymentIntent.id}, updated_at = NOW()
          WHERE id = ${occ.id}
        `
        chargesSucceeded++

        // ── Place the FM order (Direct Entry) ───────────────────────────────
        try {
          const fmRef = await placeFmOrder(occ.restaurant_reference, occ.cart_snapshot || [], date)
          await sql`
            UPDATE recurring_order_occurrences
            SET status = 'PLACED', fm_order_reference = ${fmRef}, placed_at = NOW(), updated_at = NOW()
            WHERE id = ${occ.id}
          `
          ordersPlaced++
        } catch (placeErr) {
          // Charge captured but order couldn't be placed automatically. DO NOT
          // refund — alert concierge for manual fulfillment. Status stays
          // CHARGE_ATTEMPTED (paid, awaiting placement).
          const reason = placeErr instanceof Error ? placeErr.message : String(placeErr)
          console.error(`[cron/recurring-orders] FM placement failed for occurrence ${occ.id} (charged ${paymentIntent.id}): ${reason}`)
          const alert = emailManualReview({
            restaurantName: occ.restaurant_name,
            restaurantReference: occ.restaurant_reference,
            customerName: [occ.customer_first_name, occ.customer_last_name].filter(Boolean).join(' '),
            customerEmail: occ.customer_email,
            dateISO: date,
            amount,
            paymentIntentId: paymentIntent.id,
            occurrenceId: occ.id,
            reason,
            cart: occ.cart_snapshot || [],
          })
          await sendEmail(RESTAURANT_NOTIFY_EMAIL, alert.subject, alert.html, alert.text)
          manualReview++
        }
      } catch (e) {
        errors.push(`charge ${occ.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    errors.push(`TASK B: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── TASK C — cancel unpaid orders past the 48h cutoff ──────────────────────
  // CHARGE_ATTEMPTED is deliberately excluded: with real Stripe charging it
  // means "paid, placement pending" (handled by TASK B / manual review), so it
  // must never be auto-canceled here.
  try {
    const due = await dueOccurrences(plus1, ['SCHEDULED', 'REMINDER_SENT', 'CHARGE_FAILED', 'PAYMENT_REMINDER_SENT'])
    for (const occ of due) {
      try {
        const date = normDate(occ.scheduled_date)
        await sql`
          UPDATE recurring_order_occurrences
          SET status = 'CANCELED',
              cancellation_reason = 'Payment not received 48 hours before order',
              canceled_at = NOW(),
              updated_at = NOW()
          WHERE id = ${occ.id}
        `

        const nextISO = await nextOccurrenceDate(occ.recurring_order_id, date)
        const cust = emailCanceledCustomer(occ.customer_first_name || '', occ.restaurant_name, date, nextISO)
        await sendEmail(occ.customer_email, cust.subject, cust.html, cust.text)

        const rest = emailCanceledRestaurant(
          occ.restaurant_name, occ.customer_first_name || '', occ.customer_last_name || '', occ.customer_email, date,
        )
        await sendEmail(RESTAURANT_NOTIFY_EMAIL, rest.subject, rest.html, rest.text)

        cancellations++
      } catch (e) {
        errors.push(`cancel ${occ.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    errors.push(`TASK C: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── TASK D — menu availability check ───────────────────────────────────────
  // Pause any ACTIVE order whose cart contains an item that's no longer on the
  // restaurant's menu, and tell the customer. Only orders with an occurrence in
  // the next 7 days are checked (no point paging an inactive future order).
  try {
    const orders = (await sql`
      SELECT DISTINCT r.id, r.restaurant_reference, r.restaurant_name,
             r.customer_email, r.customer_first_name
      FROM recurring_orders r
      JOIN recurring_order_occurrences o ON o.recurring_order_id = r.id
      WHERE r.status = 'ACTIVE'
        AND o.scheduled_date BETWEEN ${todayISO}::date AND ${plus7}::date
        AND o.status NOT IN ('PLACED', 'CANCELED', 'SKIPPED')
    `) as {
      id: string; restaurant_reference: string; restaurant_name: string
      customer_email: string; customer_first_name: string | null
    }[]

    for (const ord of orders) {
      try {
        const snap = (await sql`
          SELECT cart_snapshot FROM recurring_order_occurrences
          WHERE recurring_order_id = ${ord.id} AND cart_snapshot IS NOT NULL
          ORDER BY scheduled_date ASC LIMIT 1
        `) as { cart_snapshot: CartItem[] | null }[]
        const cart = snap[0]?.cart_snapshot ?? []
        if (cart.length === 0) continue

        // checkMenuAvailability throws on fetch/empty-menu errors — caught below
        // so a transient FM hiccup never falsely pauses an order.
        const result = await checkMenuAvailability(ord.restaurant_reference, cart)
        if (result.available) continue

        await sql`UPDATE recurring_orders SET status = 'PAUSED', updated_at = NOW() WHERE id = ${ord.id}`
        const { subject, html, text } = emailMenuPaused(
          ord.customer_first_name || '', ord.restaurant_name, result.unavailableItems,
        )
        await sendEmail(ord.customer_email, subject, html, text)
        menuPauses++
      } catch (e) {
        errors.push(`menu-check ${ord.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    errors.push(`TASK D: ${e instanceof Error ? e.message : String(e)}`)
  }

  return NextResponse.json({
    reminders_sent: remindersSent,
    charges_succeeded: chargesSucceeded,
    charges_failed: chargesFailed,
    orders_placed: ordersPlaced,
    manual_review: manualReview,
    cancellations,
    menu_pauses: menuPauses,
    errors,
  })
}
