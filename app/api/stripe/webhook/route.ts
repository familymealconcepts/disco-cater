import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'
import { sendCustomerOrderConfirmation, sendRestaurantOrderNotification, sendOrderEditPaymentFailed, type OrderMealPackage } from '../../../../lib/email/notifications'
import { applyPendingEdit } from '../../../../lib/order-edit'
import { waitUntil } from '@vercel/functions'

export const runtime = 'nodejs'

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook handler — Disco-native order management.
//
// SAFE TO DEPLOY ALONGSIDE FM. This handler ONLY reads/writes Disco's Neon
// tables (disco_orders, disco_sale_transactions, disco_stripe_payments,
// disco_order_events). It never calls the FamilyMeal API.
//
// Orders that originated in FM carry an fm_order_reference; Disco-native orders
// do not. Either way, the lookup key here is the Stripe object (payment intent /
// invoice metadata) against Disco's own tables — if a payment isn't present in
// disco_stripe_payments we treat it as "not a Disco order" and ack 200 so FM's
// own webhook keeps handling it. Both kinds are handled gracefully.
//
// Every branch acks with 200 (even on internal error) so Stripe never retries
// indefinitely. Errors are recorded as WEBHOOK_ERROR rows for observability.
// ─────────────────────────────────────────────────────────────────────────────

// Inserts an audit/event row. order_reference is nullable — account-, payout-,
// subscription- and error-level events are not tied to a specific order.
async function recordEvent(
  orderReference: string | null,
  eventType: string,
  eventData: unknown,
  source: string | null,
): Promise<void> {
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    VALUES (${orderReference}::uuid, ${eventType}, ${JSON.stringify(eventData)}::jsonb, ${source})
  `
}

// ── Order confirmation emails ────────────────────────────────────────────────
// Fired fire-and-forget after a successful payment. Does its own fetching so no
// DB work for the email lands in the webhook's critical path. Never throws — the
// email functions themselves return { success } and we catch around the whole
// thing as a final backstop.
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

async function dispatchOrderEmails(orderId: number): Promise<void> {
  try {
    const orders = (await sql`
      SELECT order_number, order_type, delivery_type, source_of_order, order_date, order_time, created_at,
             customer_email, customer_first_name, customer_last_name, customer_phone,
             delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
             restaurant_reference, restaurant_name, restaurant_email, tax_exempt_id, tips
      FROM disco_orders WHERE id = ${orderId} LIMIT 1
    `) as Record<string, unknown>[]
    if (orders.length === 0) return
    const o = orders[0]

    const txns = (await sql`
      SELECT subtotal, total, fee, service_charge, state_tax, local_tax, other_tax,
             tips_in_price, own_delivery_fee, third_party_delivery_fee, discount
      FROM disco_sale_transactions
      WHERE order_id = ${orderId} AND transaction_type = 'ORIGINAL' LIMIT 1
    `) as Record<string, unknown>[]
    const t = txns[0] ?? {}

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

    const subtotal = num(t.subtotal)
    const serviceCharge = num(t.service_charge)
    const taxesAndFees = num(t.state_tax) + num(t.local_tax) + num(t.other_tax) + num(t.fee)
    const deliveryFee = num(t.own_delivery_fee) + num(t.third_party_delivery_fee)
    const tip = num(t.tips_in_price) || num(o.tips)
    const promo = num(t.discount)
    const totalPrice = num(t.total)

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
        console.error('[Webhook] customer confirmation email failed:', err),
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
      }).catch((err) => console.error('[Webhook] restaurant notification email failed:', err))
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
    console.error('[Webhook] dispatchOrderEmails failed:', err instanceof Error ? err.message : err)
  }
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
    console.error('[Webhook] Slack notification failed:', err instanceof Error ? err.message : err)
  }
}

export async function POST(request: NextRequest) {
  // Signature verification REQUIRES the raw request body. Do NOT use
  // request.json() — parsing/re-serializing changes the bytes and the signature
  // check will always fail.
  const body = await request.text()
  const sig = request.headers.get('stripe-signature')
  // Accept events signed by EITHER the connected-account webhook secret
  // (restaurant Stripe accounts — STRIPE_ACCOUNT_WEBHOOK_SECRET) or the platform
  // webhook secret (STRIPE_WEBHOOK_SECRET). Connect account.* events are signed
  // with the account secret, so try it first and fall back to the platform one.
  const secrets = [
    process.env.STRIPE_ACCOUNT_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET,
  ].filter(Boolean) as string[]

  // During the FM→Disco transition the webhook secret may not be configured yet.
  // Rather than 500 (which would surface as failures once the endpoint is wired
  // up), warn and ack so nothing breaks. No event processing happens without a
  // verified payload.
  if (!secrets.length) {
    console.warn('[Webhook] No webhook secret configured (STRIPE_ACCOUNT_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET) — skipping verification and acking (transition period)')
    return NextResponse.json({ received: true, warning: 'signature verification skipped' }, { status: 200 })
  }
  if (!sig) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  // Instantiate lazily inside the handler (not at module scope) so an unset
  // STRIPE_SECRET_KEY can't crash `next build`'s page-data collection. The api
  // key isn't used by signature verification (which relies on the webhook
  // secret), but the SDK constructor requires a value.
  const stripe = new Stripe(
    process.env.STRIPE_SECRET_KEY || '',
    { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1],
  )

  // Verify against each configured secret; accept the first that validates.
  // (Account-signed events won't verify with the platform secret and vice versa.)
  let event: Stripe.Event | null = null
  let lastErr: unknown = null
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, secret)
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!event) {
    // Bad signature against every secret → reject (don't process an unverified payload).
    console.error('[Webhook] Signature verification failed:', lastErr instanceof Error ? lastErr.message : lastErr)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // Ensure Disco's order tables exist before we write. This also applies the
  // self-healing ALTER that relaxes disco_order_events.order_reference to
  // nullable (account/payout/subscription/error events record with NULL).
  // Idempotent and cached per-lambda in lib/db.ts. Best-effort: if it fails we
  // still attempt the handler and always ack 200.
  try {
    await runDiscoOrderMigrations()
  } catch (migErr) {
    console.error('[Webhook] Schema ensure failed (continuing):', migErr instanceof Error ? migErr.message : migErr)
  }

  // Each event is processed inside a try/catch. On any failure we log, record a
  // WEBHOOK_ERROR row, and still ack 200 — we never throw and never trigger a
  // Stripe retry storm.
  try {
    switch (event.type) {
      // ── payment_intent.succeeded — the critical "order paid" confirmation ──
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent
        const customer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null
        console.log('[Webhook] payment_intent.succeeded:', pi.id, pi.amount, customer)

        const payments = (await sql`
          SELECT order_reference FROM disco_stripe_payments
          WHERE stripe_payment_intent_id = ${pi.id} LIMIT 1
        `) as { order_reference: string }[]

        if (payments.length === 0) {
          console.log('[Webhook] payment_intent.succeeded — not a Disco order, skipping:', pi.id)
          break
        }

        const orderReference = payments[0].order_reference

        await sql`
          UPDATE disco_stripe_payments
          SET status = 'SUCCEEDED', updated_at = NOW()
          WHERE stripe_payment_intent_id = ${pi.id}
        `

        const orders = (await sql`
          SELECT id, reference FROM disco_orders WHERE reference = ${orderReference}::uuid LIMIT 1
        `) as { id: number; reference: string }[]

        if (orders.length > 0) {
          const order = orders[0]

          await sql`
            UPDATE disco_orders SET order_status = 'DUE', updated_at = NOW() WHERE id = ${order.id}
          `

          const txns = (await sql`
            SELECT id FROM disco_sale_transactions
            WHERE order_id = ${order.id} AND transaction_type = 'ORIGINAL' LIMIT 1
          `) as { id: number }[]

          if (txns.length > 0) {
            await sql`
              UPDATE disco_sale_transactions
              SET transaction_status = 'PAID',
                  stripe_payment_intent_id = ${pi.id},
                  paid_at = NOW(),
                  updated_at = NOW()
              WHERE id = ${txns[0].id}
            `
          }

          await recordEvent(order.reference, 'PAYMENT_SUCCEEDED', event, 'STRIPE_WEBHOOK')

          // Order confirmation emails. waitUntil keeps the email send alive
          // after the 200 ack is returned, so it completes even though we don't
          // block the response on it. dispatch does its own fetching and never
          // throws.
          waitUntil(dispatchOrderEmails(order.id))
        } else {
          // Payment row exists but order is missing — still log against the ref.
          console.warn('[Webhook] payment_intent.succeeded — payment found but order missing:', orderReference)
          await recordEvent(orderReference, 'PAYMENT_SUCCEEDED', event, 'STRIPE_WEBHOOK')
        }
        break
      }

      // ── payment_intent.payment_failed ──
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent
        console.log('[Webhook] payment_intent.payment_failed:', pi.id)

        const payments = (await sql`
          SELECT order_reference FROM disco_stripe_payments
          WHERE stripe_payment_intent_id = ${pi.id} LIMIT 1
        `) as { order_reference: string }[]

        if (payments.length === 0) {
          console.log('[Webhook] payment_intent.payment_failed — not a Disco order, skipping:', pi.id)
          break
        }

        const orderReference = payments[0].order_reference

        await sql`
          UPDATE disco_stripe_payments SET status = 'FAILED', updated_at = NOW()
          WHERE stripe_payment_intent_id = ${pi.id}
        `
        // Edit-delta charges (kind='order_edit') must NOT flip the whole order to
        // PAYMENT_FAILED — the original order is still paid; only the edit failed.
        const isEditDelta = pi.metadata?.kind === 'order_edit'
        if (isEditDelta) {
          console.log('[Webhook] payment_intent.payment_failed — edit-delta charge, order status left intact:', orderReference)
        } else {
          await sql`
            UPDATE disco_orders SET order_status = 'PAYMENT_FAILED', updated_at = NOW()
            WHERE reference = ${orderReference}::uuid
          `
          console.log('[Webhook] payment_intent.payment_failed — checkout order marked PAYMENT_FAILED:', orderReference)
        }
        await recordEvent(orderReference, 'PAYMENT_FAILED', event, 'STRIPE_WEBHOOK')
        break
      }

      // ── charge.refunded ──
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        const piId =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null
        console.log('[Webhook] charge.refunded:', charge.id, charge.amount_refunded, piId)

        if (!piId) {
          console.log('[Webhook] charge.refunded — no payment_intent, skipping:', charge.id)
          break
        }

        const payments = (await sql`
          SELECT order_reference FROM disco_stripe_payments
          WHERE stripe_payment_intent_id = ${piId} LIMIT 1
        `) as { order_reference: string }[]

        if (payments.length === 0) {
          console.log('[Webhook] charge.refunded — not a Disco order, skipping:', piId)
          break
        }

        await recordEvent(payments[0].order_reference, 'CHARGE_REFUNDED', event, 'STRIPE_WEBHOOK')
        break
      }

      // ── invoice.paid — Disco-native order EDIT confirmation ──
      // A pending edit was invoiced for the additional amount; the customer just
      // paid. Apply the proposed edit to FM + Neon and confirm.
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice
        console.log('[Webhook] invoice.paid:', invoice.id)

        const orders = (await sql`
          SELECT id, reference, pending_edit_data FROM disco_orders
          WHERE pending_stripe_invoice_id = ${invoice.id} LIMIT 1
        `) as { id: number; reference: string; pending_edit_data: Record<string, unknown> | null }[]

        if (orders.length === 0) {
          // Not a pending-edit invoice — the invoice.payment_succeeded branch (or
          // FM's own webhook) handles original-order invoices.
          console.log('[Webhook] invoice.paid — no pending edit for invoice, skipping:', invoice.id)
          break
        }

        const order = orders[0]
        // Apply the proposed edit (Neon money/date/items + edit row + payment row
        // + FM sync + confirmation email) — shared with the edit-status route.
        const invPi = (invoice as unknown as { payment_intent?: string | { id?: string } | null }).payment_intent
        const editPiId = typeof invPi === 'string' ? invPi : (invPi?.id ?? null)
        await applyPendingEdit({
          orderId: order.id,
          orderReference: order.reference,
          pending: order.pending_edit_data || {},
          invoiceId: invoice.id,
          paymentIntentId: editPiId,
        })
        break
      }

      // ── invoice.payment_succeeded ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        // Order-edit invoices are confirmed by the invoice.paid branch above.
        if (invoice.metadata?.kind === 'order_edit') {
          console.log('[Webhook] invoice.payment_succeeded — order_edit invoice, handled by invoice.paid:', invoice.id)
          break
        }
        const piId = (invoice as unknown as { payment_intent?: string | { id: string } | null }).payment_intent
        const orderReference = invoice.metadata?.orderReference
        console.log('[Webhook] invoice.payment_succeeded:', invoice.id, piId, orderReference)

        if (!orderReference) {
          console.log('[Webhook] invoice.payment_succeeded — no orderReference metadata, skipping:', invoice.id)
          break
        }

        const orders = (await sql`
          SELECT id, reference FROM disco_orders WHERE reference = ${orderReference}::uuid LIMIT 1
        `) as { id: number; reference: string }[]

        if (orders.length === 0) {
          console.log('[Webhook] invoice.payment_succeeded — order not found, skipping:', orderReference)
          break
        }

        const order = orders[0]
        await sql`
          UPDATE disco_orders SET stripe_invoice_status = 'paid', updated_at = NOW() WHERE id = ${order.id}
        `
        await sql`
          UPDATE disco_sale_transactions
          SET transaction_status = 'PAID', paid_at = NOW()
          WHERE order_id = ${order.id} AND transaction_type = 'ORIGINAL'
        `
        await recordEvent(order.reference, 'INVOICE_PAID', event, 'STRIPE_WEBHOOK')
        break
      }

      // ── invoice.payment_failed ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const orderReference = invoice.metadata?.orderReference
        console.log('[Webhook] invoice.payment_failed:', invoice.id, orderReference)

        // Pending order-edit invoice: keep edit_status = 'pending_payment' and
        // prompt the customer to update their payment method.
        const pendingEdits = (await sql`
          SELECT id, reference, pending_edit_data FROM disco_orders
          WHERE pending_stripe_invoice_id = ${invoice.id} LIMIT 1
        `) as { id: number; reference: string; pending_edit_data: Record<string, unknown> | null }[]
        if (pendingEdits.length > 0) {
          const p = (pendingEdits[0].pending_edit_data || {}) as Record<string, unknown>
          await sql`UPDATE disco_order_edits SET payment_status = 'failed' WHERE stripe_invoice_id = ${invoice.id}`
          await recordEvent(pendingEdits[0].reference, 'ORDER_EDIT_PAYMENT_FAILED', { invoiceId: invoice.id }, 'STRIPE_WEBHOOK')
          const customerEmail = String(p.customerEmail || '')
          if (customerEmail) {
            sendOrderEditPaymentFailed({
              to: customerEmail, firstName: String(p.firstName || ''),
              orderNumber: String(p.orderNumber || ''), businessName: String(p.businessName || 'the restaurant'),
              amountDue: Number(p.delta) || 0,
              updatePaymentUrl: (invoice.hosted_invoice_url as string) || undefined,
            }).catch((err) => console.error('[Webhook] edit payment-failed email failed:', err))
          }
          break
        }

        if (!orderReference) {
          console.log('[Webhook] invoice.payment_failed — no orderReference metadata, skipping:', invoice.id)
          break
        }

        const orders = (await sql`
          SELECT id, reference FROM disco_orders WHERE reference = ${orderReference}::uuid LIMIT 1
        `) as { id: number; reference: string }[]

        if (orders.length === 0) {
          console.log('[Webhook] invoice.payment_failed — order not found, skipping:', orderReference)
          break
        }

        const order = orders[0]
        await sql`
          UPDATE disco_orders SET stripe_invoice_status = 'failed', updated_at = NOW() WHERE id = ${order.id}
        `
        await recordEvent(order.reference, 'INVOICE_PAYMENT_FAILED', event, 'STRIPE_WEBHOOK')
        break
      }

      // ── account.updated (Connect) — monitoring only ──
      case 'account.updated': {
        const account = event.data.object as Stripe.Account
        console.log(
          '[Webhook] Connected account updated:',
          account.id,
          account.charges_enabled,
          account.payouts_enabled,
        )
        await recordEvent(
          null,
          'CONNECTED_ACCOUNT_UPDATED',
          {
            accountId: account.id,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
          },
          'STRIPE_WEBHOOK',
        )
        break
      }

      // ── payout.paid / payout.failed — monitoring only ──
      case 'payout.paid':
      case 'payout.failed': {
        const payout = event.data.object as Stripe.Payout
        const accountId = event.account ?? null
        const eventType = event.type === 'payout.paid' ? 'PAYOUT_PAID' : 'PAYOUT_FAILED'
        console.log('[Webhook]', eventType, ':', payout.id, payout.amount, payout.arrival_date, accountId)
        await recordEvent(
          null,
          eventType,
          {
            payoutId: payout.id,
            amount: payout.amount,
            arrivalDate: payout.arrival_date,
            accountId,
          },
          'STRIPE_WEBHOOK',
        )
        break
      }

      // ── customer.subscription.* — monitoring only ──
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null
        const eventType =
          event.type === 'customer.subscription.created'
            ? 'SUBSCRIPTION_CREATED'
            : event.type === 'customer.subscription.updated'
              ? 'SUBSCRIPTION_UPDATED'
              : 'SUBSCRIPTION_DELETED'
        console.log('[Webhook]', eventType, ':', sub.id, sub.status, customer)
        await recordEvent(
          null,
          eventType,
          { subscriptionId: sub.id, status: sub.status, customer },
          'STRIPE_WEBHOOK',
        )
        break
      }

      default:
        console.log('[Webhook] Unhandled event:', event.type)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[Webhook] Error handling event', event.type, ':', message)
    // Best-effort error record; swallow any failure here so we still ack 200.
    try {
      await recordEvent(null, 'WEBHOOK_ERROR', { eventType: event.type, error: message }, 'STRIPE_WEBHOOK')
    } catch (recordErr) {
      console.error(
        '[Webhook] Failed to record WEBHOOK_ERROR:',
        recordErr instanceof Error ? recordErr.message : recordErr,
      )
    }
  }

  // Always 200 for verified events (including unhandled types and internal
  // errors) so Stripe does not retry indefinitely.
  return NextResponse.json({ received: true }, { status: 200 })
}
