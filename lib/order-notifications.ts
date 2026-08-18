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
import {
  sendCustomerOrderConfirmation, sendRestaurantOrderNotification, type OrderMealPackage, type OrderAddOn,
  sendCustomerItemUnavailableRefund, sendRestaurantItemUnavailableAlert,
} from './email/notifications'
import { buildOrderPdfByReference } from './order/order-pdf'
import { sendSms } from './sms'
import { formatTimeWindow } from './utils/deliveryTimeWindow'
import { sanitizePhone } from './utils/phone'

// Same sentinel shape importRestaurantStripeAccount (lib/native-conversion.ts)
// creates for a login-disabled holder row — provably never deliverable (confirmed
// via Mailgun: hard bounce, "No Such User", every time). Never used as a real
// notification recipient.
const SENTINEL_EMAIL_RE = /^stripe-import\+.+@familymeal\.com$/i

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
    // ON CONFLICT against the partial unique index disco_order_events_once_uq.
    // The old INSERT ... WHERE NOT EXISTS could let two concurrent callers both
    // win the claim; this cannot. The WHERE clause must match the index
    // predicate exactly so Postgres can infer the right index.
    const rows = (await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${orderReference}::uuid, 'ORDER_CONFIRMATIONS_SENT', '{}'::jsonb, ${source})
      ON CONFLICT (order_reference, event_type)
        WHERE event_type IN ('ORDER_CONFIRMATIONS_SENT', 'SLACK_NOTIFIED')
        DO NOTHING
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
    // Atomic via disco_order_events_once_uq — see claimConfirmationSend().
    const rows = (await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${orderReference}::uuid, 'SLACK_NOTIFIED', '{}'::jsonb, 'order-notifications')
      ON CONFLICT (order_reference, event_type)
        WHERE event_type IN ('ORDER_CONFIRMATIONS_SENT', 'SLACK_NOTIFIED')
        DO NOTHING
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
// opts.force skips the once-only claim (for a deliberate admin resend);
// opts.customerOnly sends just the customer confirmation email (no restaurant
// email / SMS / Slack) and awaits it. Both default off — normal dispatch unchanged.
export async function dispatchOrderConfirmations(
  orderId: number,
  source: string = 'STRIPE_WEBHOOK',
  opts?: { force?: boolean; customerOnly?: boolean },
): Promise<void> {
  try {
    const orders = (await sql`
      SELECT reference, order_number, order_type, delivery_type, source_of_order, order_date, order_time, delivery_time_window, note, created_at,
             customer_email, customer_first_name, customer_last_name, customer_phone,
             delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
             restaurant_reference, restaurant_name, restaurant_email, tax_exempt_id, tax_exempt_state, tips,
             subtotal, total, fee, refund, persons, company_name
      FROM disco_orders WHERE id = ${orderId} LIMIT 1
    `) as Record<string, unknown>[]
    if (orders.length === 0) return
    const o = orders[0]

    // One-time guard — skip if confirmations were already sent for this order.
    // A forced resend (admin) deliberately bypasses the guard.
    const reference = o.reference ? String(o.reference) : ''
    if (reference && !opts?.force) {
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
    let cacheTimezone = ''
    // Drives the Slack suppression below. Defaults FALSE (= treat as FM-backed =
    // don't send) so an unknown restaurant errs toward a missing ping rather than
    // a duplicate — the same trade-off claimSlackNotified() makes.
    let cacheIsNative = false
    try {
      const rc = (await sql`
        SELECT name, location, address, phone, timezone, is_disco_native FROM disco_restaurant_cache WHERE restaurant_reference = ${restRef} LIMIT 1
      `) as { name: string | null; location: string | null; address: string | null; phone: string | null; timezone: string | null; is_disco_native: boolean | null }[]
      cacheName = rc[0]?.name || ''
      cacheLocation = rc[0]?.location || ''
      cacheAddress = rc[0]?.address || ''
      cachePhone = rc[0]?.phone || ''
      cacheTimezone = rc[0]?.timezone || ''
      cacheIsNative = rc[0]?.is_disco_native === true
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
      SELECT id, name, quantity, price_per_unit, notes FROM disco_order_items
      WHERE order_id = ${orderId} ORDER BY id
    `) as Record<string, unknown>[]

    // Per-item add-ons — same join order-pdf.ts and the restaurant portal's
    // order popout already do. Without this, an item whose real price lives
    // entirely on its add-ons (base price_per_unit priced at $0.00) showed as
    // "$0.00" in both the customer receipt and restaurant notification with
    // no indication the money was on a modifier — third instance of this
    // exact bug (order-pdf.ts and orders/[ref]/route.ts had it too).
    const itemIds = items.map((it) => Number(it.id)).filter((n) => Number.isFinite(n))
    const addonRows = itemIds.length
      ? ((await sql`
          SELECT order_item_id, name, price, quantity FROM disco_order_item_addons
          WHERE order_item_id = ANY(${itemIds}) ORDER BY id
        `.catch(() => [])) as Record<string, unknown>[])
      : []
    const addOnsByItem = new Map<number, OrderAddOn[]>()
    for (const a of addonRows) {
      const key = Number(a.order_item_id)
      const list = addOnsByItem.get(key) ?? []
      list.push({ count: num(a.quantity) || 1, name: String(a.name ?? 'Add-on'), price: num(a.price) })
      addOnsByItem.set(key, list)
    }

    const orderMealPackages: OrderMealPackage[] = items.map((it) => ({
      count: num(it.quantity) || 1,
      name: String(it.name ?? ''),
      price: num(it.price_per_unit),
      comment: it.notes ? String(it.notes) : undefined,
      orderAddOns: addOnsByItem.get(Number(it.id)),
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
      // Delivery orders with a non-'exact' window snapshot show a time range;
      // pickup / null / 'exact' → exact time (formatTimeWindow handles the gating).
      orderTime: formatTimeWindow(String(o.order_time ?? ''), o.delivery_time_window as string | null, isDelivery),
      // "Order Received" in the restaurant's local timezone (was UTC, which read
      // ~4h ahead for an EDT restaurant). Falls back to America/New_York.
      orderReceived: o.created_at
        ? new Date(o.created_at as string).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: cacheTimezone || 'America/New_York' })
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
      note: o.note ? String(o.note) : undefined,
      // Prefer the canonical cache name; fall back to the order's stored name.
      businessName: cacheName || (o.restaurant_name ? String(o.restaurant_name) : '') || 'the restaurant',
      // Store contact (FM format) — canonical in disco_restaurant_cache.
      businessPhone: cachePhone || undefined,
      addressLine1: cacheAddress || undefined,
    }

    // Build the order PDF once and attach it to BOTH the customer and restaurant
    // confirmation emails (was restaurant-only — the customer email never carried
    // the PDF, Bug 2). Best-effort: a PDF failure must never block the emails.
    let pdfAttachments: { filename: string; content: Uint8Array; contentType: string }[] | undefined
    if (reference) {
      try {
        const pdf = await buildOrderPdfByReference(reference)
        if (pdf) pdfAttachments = [{ filename: `disco-cater-order-${shared.orderNumber}.pdf`, content: pdf, contentType: 'application/pdf' }]
      } catch (err) {
        console.error('[order-notifications] order PDF build failed (sending email without it):', err instanceof Error ? err.message : err)
      }
    }

    // Customer confirmation — needs a recipient.
    if (shared.userEmail) {
      const sendP = sendCustomerOrderConfirmation({ to: shared.userEmail, attachments: pdfAttachments, ...shared }).catch((err) => {
        console.error('[order-notifications] customer confirmation email failed:', err)
        return { success: false }
      })
      // Admin resend: send ONLY the customer email (await it so the caller knows it
      // went) and skip the restaurant email / SMS / Slack below.
      if (opts?.customerOnly) { await sendP; return }
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
    let recipientList = notificationEmails.length ? notificationEmails : (restaurantEmail ? [restaurantEmail] : [])
    // Fallback: a restaurant with no configured notification_emails AND no order
    // restaurant_email (common for Disco-native restaurants — Test 34) would
    // otherwise get ZERO notification about its own order. Default to the
    // restaurant admin's own account email so the restaurant is always notified —
    // EXCEPT the stripe-import sentinel placeholder, which is provably never
    // deliverable (confirmed via Mailgun: hard bounce, "No Such User", every time).
    // Falling back to it doesn't just fail silently — it's worse than nothing,
    // since ORDER_CONFIRMATIONS_SENT still gets claimed and looks like success.
    if (recipientList.length === 0 && restRef) {
      try {
        const acct = (await sql`
          SELECT email FROM disco_restaurant_accounts
          WHERE restaurant_reference = ${restRef} AND email IS NOT NULL
          ORDER BY created_at ASC LIMIT 1
        `) as { email: string }[]
        if (acct[0]?.email && !SENTINEL_EMAIL_RE.test(acct[0].email)) recipientList = [acct[0].email]
      } catch { /* best-effort — leave empty rather than block the customer email */ }
    }
    const uniqueRecipients = Array.from(new Set(recipientList.map((e) => e.toLowerCase())))
    if (uniqueRecipients.length === 0) {
      // No real recipient at any fallback level — skip rather than send nowhere,
      // logged so the gap is visible (matches the pre-flight tool's own
      // sentinel-login-only / no-login-yet warnings for the same underlying cause).
      console.warn('[order-notifications] no real restaurant recipient at any fallback level — skipping restaurant notification:', reference, restRef)
    }
    // FM visibility (native-checkout ONLY — explicit gate here, not just relying on
    // every call site being correctly scoped, since dispatchOrderConfirmations is
    // invoked from several places): every Disco-native order confirmation is also
    // copied to noreply@familymeal.com. FAMILYMEAL-sourced orders never take this
    // branch — those are FM's own responsibility to notify, unaffected by this change.
    const isNativeCheckout = sourceOfOrder !== 'FAMILYMEAL'
    // pdfAttachments was built once above (shared by the customer + restaurant emails).
    // Bcc'd on the FIRST real recipient's send only, so a restaurant with multiple
    // configured recipients doesn't produce multiple FM copies of one order. If
    // there's no real restaurant recipient at all, FM still gets a direct copy
    // (arguably the moment they'd most want visibility — the restaurant itself
    // isn't being notified either).
    if (uniqueRecipients.length === 0) {
      if (isNativeCheckout) {
        sendRestaurantOrderNotification({
          restaurantEmail: 'noreply@familymeal.com',
          deliveryType: o.delivery_type ? String(o.delivery_type) : undefined,
          sourceOfOrder,
          attachments: pdfAttachments,
          ...shared,
        }).catch((err) => console.error('[order-notifications] FM-copy notification failed:', err))
      }
    } else {
      uniqueRecipients.forEach((to, i) => {
        sendRestaurantOrderNotification({
          restaurantEmail: to,
          restaurantBcc: (isNativeCheckout && i === 0) ? 'noreply@familymeal.com' : undefined,
          deliveryType: o.delivery_type ? String(o.delivery_type) : undefined,
          sourceOfOrder,
          attachments: pdfAttachments,
          ...shared,
        }).catch((err) => console.error('[order-notifications] restaurant notification email failed:', err))
      })
    }

    // Disco-native restaurant SMS — send to EVERY number in the multi-phone
    // recipient list (disco_restaurant_overrides.notification_sms_numbers, CSV).
    // Falls back to the legacy per-account sms_phone (sms_enabled=true) when that
    // list is empty, so restaurants configured before the multi-recipient change
    // keep working. De-duped by normalized number. Fire-and-forget like the emails.
    try {
      const smsRestRef = String(o.restaurant_reference ?? '')
      let smsNumbers: string[] = []
      let textNotificationsEnabled = false
      try {
        const ovRows = (await sql`
          SELECT notification_sms_numbers, text_notifications_enabled FROM disco_restaurant_overrides WHERE restaurant_reference = ${smsRestRef} LIMIT 1
        `) as { notification_sms_numbers: string | null; text_notifications_enabled: boolean | null }[]
        textNotificationsEnabled = ovRows[0]?.text_notifications_enabled === true
        smsNumbers = String(ovRows[0]?.notification_sms_numbers || '').split(',').map((s) => s.trim()).filter(Boolean)
      } catch { /* column may not exist on a brand-new DB — fall back below */ }
      // Gate: only text when the restaurant's "Send order notifications by text
      // message" toggle is ON. Configured numbers alone are NOT enough — a
      // restaurant may have entered numbers but turned texts off. Applies to both
      // the CSV recipient list AND the legacy per-account fallback.
      if (!textNotificationsEnabled) {
        smsNumbers = []
      } else if (smsNumbers.length === 0) {
        const accts = (await sql`
          SELECT sms_phone FROM disco_restaurant_accounts
          WHERE restaurant_reference = ${smsRestRef}
            AND sms_enabled = true AND sms_phone IS NOT NULL AND sms_phone <> ''
        `) as { sms_phone: string }[]
        smsNumbers = accts.map((a) => a.sms_phone).filter(Boolean)
      }
      if (smsNumbers.length) {
        const customerName = [shared.firstName, shared.lastName].filter(Boolean).join(' ')
        // Link to the downloadable order PDF (matches FM's texts). UUID-gated route.
        const pdfLink = reference ? `discocater.com/api/order/${reference}/pdf` : ''
        const smsBody = `New Disco Cater order! #${shared.orderNumber} — ${customerName} — ${shared.orderService} on ${shared.orderDate} at ${shared.orderTime} — $${totalPrice.toFixed(2)}.${pdfLink ? ` View/download PDF: ${pdfLink}` : ''}`
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

    // New-order Slack ping. Restaurant name + City/State come from
    // disco_restaurant_cache (location = "City, State").
    //
    // DISCO-NATIVE ONLY. FM-backed orders are paid through FM's Stripe, so
    // /api/order/confirm-payment calls FM's /api/userOrder/confirmPayment, and
    // FM's OrderUpdateOrderStatusTaskRunnable posts its OWN new-order message to
    // the same channel — with no sourceOfOrder filter, so it fires for DISCO
    // orders too. Disco sending as well is what produced two pings per order.
    // claimSlackNotified() couldn't catch it: it dedupes within Disco and has no
    // visibility into FM's send.
    //
    // Native restaurants have no FM record at all, so FM never sees those orders
    // and never notifies — Disco remains their only notification. This also
    // covers the FM_SYNC_BACKFILL path for free: those orders were pulled FROM
    // FM, so they are FM-backed by definition and FM already announced them.
    const slackOk = cacheIsNative && (reference ? await claimSlackNotified(reference) : true)
    if (!cacheIsNative) {
      console.log('[order-notifications] FM-backed order — FM sends the Slack ping, skipping Disco\'s:', reference)
    }
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

// Max Inventory Per Day — an item's atomic decrement lost the race to a
// concurrent order right after this order's payment succeeded (see
// lib/order/native-inventory.ts). The order has already been refunded and
// marked REFUNDED by the caller; this just notifies both sides. Fire-and-forget,
// never throws. Simpler than dispatchOrderConfirmations — no PDF, no SMS, no
// Slack — this is an exception path, not the happy path.
export async function dispatchInventoryUnavailableNotification(orderId: number, itemName: string): Promise<void> {
  try {
    const orders = (await sql`
      SELECT reference, order_number, order_date, restaurant_reference, restaurant_name, restaurant_email,
             customer_email, customer_first_name, total
      FROM disco_orders WHERE id = ${orderId} LIMIT 1
    `) as Record<string, unknown>[]
    if (orders.length === 0) return
    const o = orders[0]
    const restRef = String(o.restaurant_reference ?? '')

    let businessName = o.restaurant_name ? String(o.restaurant_name) : 'the restaurant'
    try {
      const rc = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${restRef} LIMIT 1`) as { name: string | null }[]
      if (rc[0]?.name) businessName = rc[0].name
    } catch { /* best-effort */ }

    const refundAmount = num(o.total)

    if (o.customer_email) {
      sendCustomerItemUnavailableRefund({
        to: String(o.customer_email),
        firstName: o.customer_first_name ? String(o.customer_first_name) : undefined,
        orderNumber: o.order_number as number,
        businessName, itemName, refundAmount,
      }).catch((err) => console.error('[order-notifications] item-unavailable customer email failed:', err))
    }

    // Same restaurant-recipient resolution as dispatchOrderConfirmations:
    // configured notification_emails → the order's restaurant_email → the
    // account's own email (excluding the never-deliverable stripe-import sentinel).
    let recipientList: string[] = []
    try {
      const ov = (await sql`SELECT notification_emails FROM disco_restaurant_overrides WHERE restaurant_reference = ${restRef} LIMIT 1`) as { notification_emails: string | null }[]
      recipientList = String(ov[0]?.notification_emails || '').split(',').map((e) => e.trim()).filter(Boolean)
    } catch { /* fall back below */ }
    if (recipientList.length === 0 && o.restaurant_email) recipientList = [String(o.restaurant_email)]
    if (recipientList.length === 0 && restRef) {
      try {
        const acct = (await sql`
          SELECT email FROM disco_restaurant_accounts
          WHERE restaurant_reference = ${restRef} AND email IS NOT NULL ORDER BY created_at ASC LIMIT 1
        `) as { email: string }[]
        if (acct[0]?.email && !SENTINEL_EMAIL_RE.test(acct[0].email)) recipientList = [acct[0].email]
      } catch { /* best-effort */ }
    }
    const uniqueRecipients = Array.from(new Set(recipientList.map((e) => e.toLowerCase())))
    for (const to of uniqueRecipients) {
      sendRestaurantItemUnavailableAlert({
        to, orderNumber: o.order_number as number, itemName,
        orderDate: o.order_date ? fmtDate(o.order_date) : undefined,
      }).catch((err) => console.error('[order-notifications] item-unavailable restaurant email failed:', err))
    }
  } catch (err) {
    console.error('[order-notifications] dispatchInventoryUnavailableNotification failed:', err instanceof Error ? err.message : err)
  }
}
