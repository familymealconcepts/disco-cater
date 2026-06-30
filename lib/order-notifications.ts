// Shared order-confirmation dispatch — customer email, restaurant email,
// restaurant SMS, and the new-order Slack ping for a paid Disco order.
//
// Why this is shared (not just in the Stripe webhook): native customer payments
// are charged on FamilyMeal's Stripe account, so Disco's own webhook NEVER
// receives a payment_intent.succeeded for them. The order-confirmation flow
// therefore can't rely on the webhook alone — /api/order/confirm-payment calls
// this directly once FM reports the charge succeeded. The Stripe webhook also
// calls it (for any Disco-Stripe order). An idempotency marker in
// disco_order_events guarantees the confirmations fire at most once per order.

import { sql } from './db'
import { sendCustomerOrderConfirmation, sendRestaurantOrderNotification, type OrderMealPackage } from './email/notifications'
import { sendSms } from './sms'
import { sanitizePhone } from './utils/phone'

// Normalize a stored phone to E.164 for Twilio: strip non-digits, prepend +1 for
// a 10-digit US number (or + for an 11-digit number already starting with 1).
function toE164(raw: string | null | undefined): string {
  const d = sanitizePhone(raw)
  if (!d) return ''
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return `+${d}`
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}
function normDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v ?? '').slice(0, 10)
}
// FM email/PDF date format: MM/DD/YYYY.
function fmtDate(v: unknown): string {
  const iso = normDateStr(v)
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y) return iso
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

// Date as M/DD/YY (no leading zero on the month) for the Slack line.
function fmtSlackDate(iso: string): string {
  const [y, m, d] = String(iso || '').split('-').map(Number)
  if (!y || !m || !d) return String(iso || '')
  return `${m}/${String(d).padStart(2, '0')}/${String(y).slice(-2)}`
}

// Posts THE single new-order notification to the Disco Slack channel, in the
// canonical format:
//   [Restaurant Name], [City, State], ($total), [1P|3P], [M/DD/YY] - ([P|D])
// 1P = FAMILYMEAL, 3P = DISCO · P = PICKUP, D = DELIVERY. Never throws; skips
// silently when SLACK_NEW_ORDER_WEBHOOK_URL is unset.
async function sendNewOrderSlack(o: {
  sourceOfOrder: string
  restaurantName: string
  city: string
  state: string
  total: number
  orderDateIso: string
  orderType: string
}): Promise<void> {
  const url = process.env.SLACK_NEW_ORDER_WEBHOOK_URL
  if (!url) return
  try {
    const tag = o.sourceOfOrder === 'DISCO' ? '3P' : '1P'
    const svc = String(o.orderType).toUpperCase() === 'DELIVERY' ? 'D' : 'P'
    const amount = `$${(Number.isFinite(o.total) ? o.total : 0).toFixed(2)}`
    const loc = [o.city, o.state].filter(Boolean).join(', ')
    // [Restaurant Name], [City, State], ($total), [1P|3P], [M/DD/YY] - ([P|D])
    // filter(Boolean) so a missing city/state doesn't leave a stray comma.
    const text = [o.restaurantName, loc, `(${amount})`, tag, `${fmtSlackDate(o.orderDateIso)} - (${svc})`]
      .filter(Boolean)
      .join(', ')
    // Send as a Slack attachment with a color so the message renders with the
    // green left border (matching the FM notifications) instead of plain text.
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: [{ color: '#36a64f', text }] }),
    })
  } catch (err) {
    console.error('[order-notifications] Slack notification failed:', err instanceof Error ? err.message : err)
  }
}

// Atomically claim the one-time confirmation send for an order. Inserts a
// CONFIRMATIONS_SENT marker only if one doesn't already exist; returns true when
// THIS call won the claim (so it should send), false when confirmations were
// already dispatched (webhook + confirm-payment can both fire — only one wins).
async function claimConfirmationSend(orderReference: string, source: string): Promise<boolean> {
  try {
    const rows = (await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      SELECT ${orderReference}::uuid, 'ORDER_CONFIRMATIONS_SENT', '{}'::jsonb, ${source}
      WHERE NOT EXISTS (
        SELECT 1 FROM disco_order_events
        WHERE order_reference = ${orderReference}::uuid AND event_type = 'ORDER_CONFIRMATIONS_SENT'
      )
      RETURNING id
    `) as { id: number }[]
    return rows.length > 0
  } catch (err) {
    // If the guard query itself fails, fall through to sending (better a rare
    // duplicate than a silently-skipped confirmation).
    console.error('[order-notifications] claim failed (sending anyway):', err instanceof Error ? err.message : err)
    return true
  }
}

// Dedicated idempotency guard for the new-order Slack ping. Belt-and-suspenders
// on top of claimConfirmationSend: even if the Slack ping is ever reached from a
// second path (a re-dispatch, an FM→Neon sync, a retry), it fires AT MOST ONCE
// per order. Returns true only for the caller that wins the SLACK_NOTIFIED claim.
async function claimSlackNotified(orderReference: string): Promise<boolean> {
  try {
    const rows = (await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      SELECT ${orderReference}::uuid, 'SLACK_NOTIFIED', '{}'::jsonb, 'order-notifications'
      WHERE NOT EXISTS (
        SELECT 1 FROM disco_order_events
        WHERE order_reference = ${orderReference}::uuid AND event_type = 'SLACK_NOTIFIED'
      )
      RETURNING id
    `) as { id: number }[]
    return rows.length > 0
  } catch (err) {
    // On guard failure prefer NOT sending — a missing Slack ping is recoverable,
    // a duplicate is the bug we're fixing.
    console.error('[order-notifications] slack claim failed (skipping to avoid dup):', err instanceof Error ? err.message : err)
    return false
  }
}

// Dispatch all confirmations for a paid order. Fire-and-forget at the call site
// (waitUntil). Does its own fetching; never throws. Sends at most once per order
// thanks to claimConfirmationSend.
export async function dispatchOrderConfirmations(orderId: number, source: string = 'STRIPE_WEBHOOK'): Promise<void> {
  try {
    const orders = (await sql`
      SELECT reference, order_number, order_type, delivery_type, source_of_order, order_date, order_time, created_at,
             customer_email, customer_first_name, customer_last_name, customer_phone,
             delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
             restaurant_reference, restaurant_name, restaurant_email, tax_exempt_id, tax_exempt_state, tips,
             subtotal, total, fee, refund, persons, company_name
      FROM disco_orders WHERE id = ${orderId} LIMIT 1
    `) as Record<string, unknown>[]
    if (orders.length === 0) return
    const o = orders[0]

    // One-time guard — skip if confirmations were already sent for this order.
    const reference = o.reference ? String(o.reference) : ''
    if (reference) {
      const won = await claimConfirmationSend(reference, source)
      if (!won) {
        console.log('[order-notifications] confirmations already sent, skipping:', reference)
        return
      }
    }

    // Money: prefer the ORIGINAL sale-transaction snapshot (FM-mirrored orders /
    // edits). Native orders placed via /api/order/place don't write a sale
    // transaction, so fall back to the money columns on disco_orders itself —
    // otherwise the email/SMS would show $0.00.
    const txns = (await sql`
      SELECT subtotal, total, fee, service_charge, state_tax, local_tax, other_tax,
             tips_in_price, own_delivery_fee, third_party_delivery_fee, discount
      FROM disco_sale_transactions
      WHERE order_id = ${orderId} AND transaction_type = 'ORIGINAL' LIMIT 1
    `) as Record<string, unknown>[]
    const t = txns[0] ?? {}
    const hasTxn = txns.length > 0

    // Restaurant name + city/state are canonical in disco_restaurant_cache
    // (disco_orders.restaurant_name is often null for native orders, which is why
    // the Slack ping showed "the restaurant").
    const restRef = String(o.restaurant_reference ?? '')
    let cacheName = ''
    let cacheLocation = ''
    let cacheAddress = ''
    let cachePhone = ''
    try {
      const rc = (await sql`
        SELECT name, location, address, phone FROM disco_restaurant_cache WHERE restaurant_reference = ${restRef} LIMIT 1
      `) as { name: string | null; location: string | null; address: string | null; phone: string | null }[]
      cacheName = rc[0]?.name || ''
      cacheLocation = rc[0]?.location || ''
      cacheAddress = rc[0]?.address || ''
      cachePhone = rc[0]?.phone || ''
    } catch { /* cache lookup is best-effort */ }

    // Total: COALESCE(disco_orders.total, disco_stripe_payments.total). Native
    // orders may carry a 0/null disco_orders.total but a real Stripe charge, which
    // is why the amount showed $0.00.
    let stripeTotal = 0
    try {
      const sp = (await sql`
        SELECT MAX(total) AS total FROM disco_stripe_payments
        WHERE order_reference = ${String(o.reference ?? '')}::uuid AND total IS NOT NULL AND total > 0
      `) as { total: string | number | null }[]
      stripeTotal = num(sp[0]?.total)
    } catch { /* stripe-total fallback is best-effort */ }

    const items = (await sql`
      SELECT name, quantity, price_per_unit, notes FROM disco_order_items
      WHERE order_id = ${orderId} ORDER BY id
    `) as Record<string, unknown>[]

    const orderMealPackages: OrderMealPackage[] = items.map((it) => ({
      count: num(it.quantity) || 1,
      name: String(it.name ?? ''),
      price: num(it.price_per_unit),
      comment: it.notes ? String(it.notes) : undefined,
    }))

    const isDelivery = String(o.order_type) === 'DELIVERY'
    const cityStateZip = [o.delivery_city, [o.delivery_state, o.delivery_zip].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ')
    const dinerAddress = isDelivery && o.delivery_address_line1 ? String(o.delivery_address_line1) : undefined
    const dinerAddress2 = isDelivery
      ? [o.delivery_address_line2, cityStateZip].filter(Boolean).join(', ') || undefined
      : undefined

    // Sale-transaction snapshot when present, else the disco_orders columns.
    const subtotal = hasTxn ? num(t.subtotal) : num(o.subtotal)
    const serviceCharge = num(t.service_charge)
    const deliveryFee = num(t.own_delivery_fee) + num(t.third_party_delivery_fee)
    const tip = num(t.tips_in_price) || num(o.tips)
    const promo = num(t.discount)
    const refund = num(o.refund)
    const totalPrice = hasTxn ? num(t.total) : (num(o.total) || stripeTotal)
    // Fees = the platform fee. Taxes are explicit on the sale-transaction
    // snapshot; native orders don't store a tax column, so derive taxes as the
    // residual that makes the visible lines reconcile to the total.
    const fees = hasTxn ? num(t.fee) : num(o.fee)
    const taxes = hasTxn
      ? num(t.state_tax) + num(t.local_tax) + num(t.other_tax)
      : Math.max(0, totalPrice - subtotal - fees - serviceCharge - tip - deliveryFee + promo)

    const shared = {
      firstName: o.customer_first_name ? String(o.customer_first_name) : undefined,
      lastName: o.customer_last_name ? String(o.customer_last_name) : undefined,
      userEmail: o.customer_email ? String(o.customer_email) : undefined,
      userPhoneNumber: o.customer_phone ? String(o.customer_phone) : undefined,
      dinerAddress,
      dinerAddress2,
      orderService: String(o.order_type ?? ''),
      orderDate: fmtDate(o.order_date),
      orderTime: fmtTime(o.order_time),
      orderReceived: o.created_at
        ? new Date(o.created_at as string).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
        : '',
      orderMealPackages,
      subtotal,
      serviceCharge,
      taxes,
      fees,
      deliveryFee,
      tip,
      promo,
      refund,
      totalPrice,
      orderNumber: o.order_number as number,
      taxExemptId: o.tax_exempt_id ? String(o.tax_exempt_id) : undefined,
      taxExemptState: o.tax_exempt_state ? String(o.tax_exempt_state) : undefined,
      persons: o.persons != null && Number(o.persons) > 0 ? Number(o.persons) : undefined,
      companyName: o.company_name ? String(o.company_name) : undefined,
      // Prefer the canonical cache name; fall back to the order's stored name.
      businessName: cacheName || (o.restaurant_name ? String(o.restaurant_name) : '') || 'the restaurant',
      // Store contact (FM format) — canonical in disco_restaurant_cache.
      businessPhone: cachePhone || undefined,
      addressLine1: cacheAddress || undefined,
    }

    // Customer confirmation — needs a recipient.
    if (shared.userEmail) {
      sendCustomerOrderConfirmation({ to: shared.userEmail, ...shared }).catch((err) =>
        console.error('[order-notifications] customer confirmation email failed:', err),
      )
    }

    // Restaurant notification — sent to EVERY address in the FM "Email Notification
    // Recipients" list (mirrored to disco_restaurant_overrides.notification_emails
    // on save), falling back to the order's single restaurant_email. De-duped.
    const sourceOfOrder = o.source_of_order ? String(o.source_of_order) : ''
    const restaurantEmail = o.restaurant_email ? String(o.restaurant_email) : ''
    let notificationEmails: string[] = []
    try {
      const ov = (await sql`
        SELECT notification_emails FROM disco_restaurant_overrides WHERE restaurant_reference = ${restRef} LIMIT 1
      `) as { notification_emails: string | null }[]
      notificationEmails = String(ov[0]?.notification_emails || '').split(',').map((e) => e.trim()).filter(Boolean)
    } catch { /* fall back to the single order email */ }
    const recipientList = notificationEmails.length ? notificationEmails : (restaurantEmail ? [restaurantEmail] : [])
    const uniqueRecipients = Array.from(new Set(recipientList.map((e) => e.toLowerCase())))
    for (const to of uniqueRecipients) {
      sendRestaurantOrderNotification({
        restaurantEmail: to,
        deliveryType: o.delivery_type ? String(o.delivery_type) : undefined,
        sourceOfOrder,
        ...shared,
      }).catch((err) => console.error('[order-notifications] restaurant notification email failed:', err))
    }

    // Disco-native restaurant SMS — send to EVERY number in the multi-phone
    // recipient list (disco_restaurant_overrides.notification_sms_numbers, CSV).
    // Falls back to the legacy per-account sms_phone (sms_enabled=true) when that
    // list is empty, so restaurants configured before the multi-recipient change
    // keep working. De-duped by normalized number. Fire-and-forget like the emails.
    try {
      const smsRestRef = String(o.restaurant_reference ?? '')
      let smsNumbers: string[] = []
      try {
        const ovRows = (await sql`
          SELECT notification_sms_numbers FROM disco_restaurant_overrides WHERE restaurant_reference = ${smsRestRef} LIMIT 1
        `) as { notification_sms_numbers: string | null }[]
        smsNumbers = String(ovRows[0]?.notification_sms_numbers || '').split(',').map((s) => s.trim()).filter(Boolean)
      } catch { /* column may not exist on a brand-new DB — fall back below */ }
      if (smsNumbers.length === 0) {
        const accts = (await sql`
          SELECT sms_phone FROM disco_restaurant_accounts
          WHERE restaurant_reference = ${smsRestRef}
            AND sms_enabled = true AND sms_phone IS NOT NULL AND sms_phone <> ''
        `) as { sms_phone: string }[]
        smsNumbers = accts.map((a) => a.sms_phone).filter(Boolean)
      }
      if (smsNumbers.length) {
        const customerName = [shared.firstName, shared.lastName].filter(Boolean).join(' ')
        const smsBody = `New Disco Cater order! #${shared.orderNumber} — ${customerName} — ${shared.orderService} on ${shared.orderDate} at ${shared.orderTime} — $${totalPrice.toFixed(2)}. Log in to view: discocater.com/restaurant/orders`
        const sent = new Set<string>()
        for (const num of smsNumbers) {
          const to = toE164(num)
          if (!to || sent.has(to)) continue
          sent.add(to)
          sendSms({ to, body: smsBody }).catch((err) => console.error('[order-notifications] restaurant SMS failed:', err))
        }
      }
    } catch (err) {
      console.error('[order-notifications] restaurant SMS lookup failed:', err instanceof Error ? err.message : err)
    }

    // New-order Slack ping (the single canonical notification). Restaurant name +
    // City/State come from disco_restaurant_cache (location = "City, State").
    // Guarded by a dedicated SLACK_NOTIFIED event so it fires at most once per
    // order even if reached from a second dispatch path (fixes the duplicate).
    const slackOk = reference ? await claimSlackNotified(reference) : true
    if (slackOk) {
      const locParts = cacheLocation.split(',').map((s) => s.trim()).filter(Boolean)
      await sendNewOrderSlack({
        sourceOfOrder,
        restaurantName: cacheName || shared.businessName,
        city: locParts[0] || '',
        state: locParts[1] || '',
        total: totalPrice,
        orderDateIso: normDateStr(o.order_date),
        orderType: shared.orderService,
      })
    } else {
      console.log('[order-notifications] Slack already notified, skipping:', reference)
    }
  } catch (err) {
    console.error('[order-notifications] dispatchOrderConfirmations failed:', err instanceof Error ? err.message : err)
  }
}
