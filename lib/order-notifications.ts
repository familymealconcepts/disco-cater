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

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}
function normDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v ?? '').slice(0, 10)
}
function fmtDate(v: unknown): string {
  const iso = normDateStr(v)
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y) return iso
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
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
    const text = `${o.restaurantName}, ${loc}, (${amount}), ${tag}, ${fmtSlackDate(o.orderDateIso)} - (${svc})`
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
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

// Dispatch all confirmations for a paid order. Fire-and-forget at the call site
// (waitUntil). Does its own fetching; never throws. Sends at most once per order
// thanks to claimConfirmationSend.
export async function dispatchOrderConfirmations(orderId: number, source: string = 'STRIPE_WEBHOOK'): Promise<void> {
  try {
    const orders = (await sql`
      SELECT reference, order_number, order_type, delivery_type, source_of_order, order_date, order_time, created_at,
             customer_email, customer_first_name, customer_last_name, customer_phone,
             delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
             restaurant_reference, restaurant_name, restaurant_email, tax_exempt_id, tips,
             subtotal, total, fee
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
    const taxesAndFees = hasTxn
      ? num(t.state_tax) + num(t.local_tax) + num(t.other_tax) + num(t.fee)
      : num(o.fee)
    const deliveryFee = num(t.own_delivery_fee) + num(t.third_party_delivery_fee)
    const tip = num(t.tips_in_price) || num(o.tips)
    const promo = num(t.discount)
    const totalPrice = hasTxn ? num(t.total) : num(o.total)

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
      taxesAndFees,
      deliveryFee,
      tip,
      promo,
      totalPrice,
      orderNumber: o.order_number as number,
      taxExemptId: o.tax_exempt_id ? String(o.tax_exempt_id) : undefined,
      businessName: o.restaurant_name ? String(o.restaurant_name) : 'the restaurant',
    }

    // Customer confirmation — needs a recipient.
    if (shared.userEmail) {
      sendCustomerOrderConfirmation({ to: shared.userEmail, ...shared }).catch((err) =>
        console.error('[order-notifications] customer confirmation email failed:', err),
      )
    }

    // Restaurant notification — only when the restaurant has an email on file.
    const sourceOfOrder = o.source_of_order ? String(o.source_of_order) : ''
    const restaurantEmail = o.restaurant_email ? String(o.restaurant_email) : ''
    if (restaurantEmail) {
      sendRestaurantOrderNotification({
        restaurantEmail,
        deliveryType: o.delivery_type ? String(o.delivery_type) : undefined,
        sourceOfOrder,
        ...shared,
      }).catch((err) => console.error('[order-notifications] restaurant notification email failed:', err))
    }

    // Disco-native restaurant SMS — opt-in per restaurant (disco_restaurant_
    // accounts.sms_enabled + sms_phone). Fire-and-forget like the emails above.
    try {
      const acct = (await sql`
        SELECT sms_phone FROM disco_restaurant_accounts
        WHERE restaurant_reference = ${String(o.restaurant_reference ?? '')}
          AND sms_enabled = true AND sms_phone IS NOT NULL AND sms_phone <> ''
        ORDER BY id LIMIT 1
      `) as { sms_phone: string }[]
      const smsPhone = acct[0]?.sms_phone
      if (smsPhone) {
        const customerName = [shared.firstName, shared.lastName].filter(Boolean).join(' ')
        const smsBody = `New Disco Cater order! #${shared.orderNumber} — ${customerName} — ${shared.orderService} on ${shared.orderDate} at ${shared.orderTime} — $${totalPrice.toFixed(2)}. Log in to view: discocater.com/restaurant/orders`
        sendSms({ to: smsPhone, body: smsBody }).catch((err) => console.error('[order-notifications] restaurant SMS failed:', err))
      }
    } catch (err) {
      console.error('[order-notifications] restaurant SMS lookup failed:', err instanceof Error ? err.message : err)
    }

    // New-order Slack ping (the single canonical notification). City/State come
    // from the restaurant cache ("City, State"), matching the required format.
    let rCity = ''
    let rState = ''
    try {
      const rc = (await sql`
        SELECT location FROM disco_restaurant_cache WHERE restaurant_reference = ${String(o.restaurant_reference ?? '')} LIMIT 1
      `) as { location: string | null }[]
      const parts = (rc[0]?.location || '').split(',').map((s) => s.trim()).filter(Boolean)
      rCity = parts[0] || ''
      rState = parts[1] || ''
    } catch { /* location is best-effort */ }

    await sendNewOrderSlack({
      sourceOfOrder,
      restaurantName: shared.businessName,
      city: rCity,
      state: rState,
      total: totalPrice,
      orderDateIso: normDateStr(o.order_date),
      orderType: shared.orderService,
    })
  } catch (err) {
    console.error('[order-notifications] dispatchOrderConfirmations failed:', err instanceof Error ? err.message : err)
  }
}
