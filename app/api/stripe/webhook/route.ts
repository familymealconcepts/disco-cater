import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'

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

export async function POST(request: NextRequest) {
  // Signature verification REQUIRES the raw request body. Do NOT use
  // request.json() — parsing/re-serializing changes the bytes and the signature
  // check will always fail.
  const body = await request.text()
  const sig = request.headers.get('stripe-signature')
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  // During the FM→Disco transition the webhook secret may not be configured yet.
  // Rather than 500 (which would surface as failures once the endpoint is wired
  // up), warn and ack so nothing breaks. No event processing happens without a
  // verified payload.
  if (!secret) {
    console.warn('[Webhook] STRIPE_WEBHOOK_SECRET not configured — skipping verification and acking (transition period)')
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

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret)
  } catch (err) {
    // Bad signature → reject (do not process an unverified payload).
    console.error('[Webhook] Signature verification failed:', err instanceof Error ? err.message : err)
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
        await sql`
          UPDATE disco_orders SET order_status = 'EXPIRED', updated_at = NOW()
          WHERE reference = ${orderReference}::uuid
        `
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

      // ── invoice.payment_succeeded ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
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
