import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'
import { sendOrderEditPaymentFailed } from '../../../../lib/email/notifications'
import { dispatchOrderConfirmations } from '../../../../lib/order-notifications'
import { handleNativePaymentIntentSucceeded } from '../../../../lib/order/native-payment-succeeded'
import { applyPendingEdit } from '../../../../lib/order-edit'
import { alertOps } from '../../../../lib/ops-alert'
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

// Fires the "Stripe Connected" Slack ping the moment a restaurant's connected
// account FIRST transitions to fully connected (charges_enabled + payouts_enabled
// + details_submitted all true) — for every restaurant going forward, native-first
// or FM-converted alike, not just Almost Home. Reuses FM's own documented
// stripe-connected-path webhook (same channel FM used to notify on this exact
// event), confirmed still live.
//
// Duplicate guard: the UPDATE ... WHERE stripe_connected_notified_at IS NULL ...
// RETURNING is the actual guard, not just a courtesy check — Stripe re-sends
// account.updated on every subsequent capability ping (and can redeliver the same
// event), so this must be atomic. Only the row transitioning NULL -> NOW() in
// THIS call proceeds to notify; every later call (same account, already
// connected) matches zero rows and no-ops.
export async function notifyStripeConnectedIfNewlyFullyConnected(account: Stripe.Account): Promise<void> {
  const fullyConnected = account.charges_enabled === true && account.payouts_enabled === true && account.details_submitted === true
  if (!fullyConnected) return

  const claimed = (await sql`
    UPDATE disco_restaurant_accounts
    SET stripe_connected_notified_at = NOW()
    WHERE stripe_account_id = ${account.id} AND stripe_connected_notified_at IS NULL
    RETURNING restaurant_reference, restaurant_name, business_name, email
  `) as { restaurant_reference: string | null; restaurant_name: string | null; business_name: string | null; email: string | null }[]
  if (claimed.length === 0) return // no matching account row, or already notified

  const url = process.env.SLACK_STRIPE_CONNECTED_WEBHOOK_URL
  if (!url) {
    console.warn('[Webhook] Stripe fully connected but SLACK_STRIPE_CONNECTED_WEBHOOK_URL is not configured — notification skipped:', account.id)
    return
  }
  const r = claimed[0]
  const name = r.restaurant_name || r.business_name || r.email || account.id
  const text = `💳 *Stripe Connected* — ${name} has completed Stripe onboarding and can now accept payments. (${account.id})`
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch (err) {
    console.error('[Webhook] Stripe-connected Slack notification failed:', err instanceof Error ? err.message : err)
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
      // Extracted to lib/order/native-payment-succeeded.ts so the stale-RESERVED
      // expiry sweep can reconcile an order whose webhook delivery was missed
      // (confirmed real: 2 of 5 stuck-RESERVED native orders found 2026-08-14
      // had ALREADY succeeded in Stripe) via the exact same, complete path
      // (inventory decrement, confirmations, dispatch) instead of a partial copy.
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent
        await handleNativePaymentIntentSucceeded(pi, stripe, 'STRIPE_WEBHOOK')
        break
      }

      // ── payment_intent.payment_failed ──
      // The only writer of order_status='PAYMENT_FAILED' anywhere in the app.
      // As of the order-status audit this value has zero rows in disco_orders
      // — that's sample size (native order volume is small and a payment
      // *failure* is a rarer subset of an already-small population), not dead
      // code. Confirm this branch still executes before ever treating
      // PAYMENT_FAILED as safe to drop from the CHECK constraint.
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

        // Native order-edit invoice: move the restaurant's share of the delta via
        // a manual Connect transfer, mirroring the native_order_invoice payout
        // below — metadata was stashed at invoice-creation time (edit route) so
        // this never re-prices. No-ops for FM-backed edits (no metadata present).
        {
          const transferDollars = Number(invoice.metadata?.transferDollars || 0)
          const connectedAccountId = String(invoice.metadata?.connectedAccountId || '')
          const withhold = invoice.metadata?.withholdPayouts === '1'
          if (!withhold && connectedAccountId && transferDollars > 0) {
            const invCharge = (invoice as unknown as { charge?: string | { id?: string } | null }).charge
            const chargeId = typeof invCharge === 'string' ? invCharge : (invCharge?.id ?? null)
            try {
              // idempotencyKey → a webhook retry can't double-pay the restaurant.
              await stripe.transfers.create({
                amount: Math.round(transferDollars * 100),
                currency: 'usd',
                destination: connectedAccountId,
                ...(chargeId ? { source_transaction: chargeId } : {}),
                transfer_group: order.reference,
                metadata: { orderReference: order.reference, kind: 'native_edit_payout' },
              }, { idempotencyKey: `native-edit-invoice-transfer-${invoice.id}` })
            } catch (e) {
              console.error('[Webhook] order-edit invoice payout transfer failed:', e instanceof Error ? e.message : e)
              await alertOps('order-edit invoice paid but payout transfer failed', {
                invoiceId: invoice.id, orderReference: order.reference,
                error: e instanceof Error ? e.message : String(e),
              })
            }
          }
        }
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

        // ── M7 native invoice order: finish the order like a paid card order ──
        // Flip UNPAID→DUE, transfer the restaurant's payout to their connected
        // account (platform-invoice + transfer, mirroring the card destination
        // charge), and dispatch confirmations. Gated on the native kind so FM /
        // order-edit / subscription invoices are untouched.
        if (invoice.metadata?.kind === 'native_order_invoice') {
          // First payment only — the guard makes retries a no-op.
          await sql`UPDATE disco_orders SET order_status = 'DUE', updated_at = NOW() WHERE id = ${order.id} AND order_status = 'UNPAID'`

          const transferDollars = Number(invoice.metadata?.transferDollars || 0)
          const connectedAccountId = String(invoice.metadata?.connectedAccountId || '')
          const withhold = invoice.metadata?.withholdPayouts === '1'
          const invCharge = (invoice as unknown as { charge?: string | { id?: string } | null }).charge
          const chargeId = typeof invCharge === 'string' ? invCharge : (invCharge?.id ?? null)
          if (!withhold && connectedAccountId && transferDollars > 0) {
            try {
              // idempotencyKey → a webhook retry can't double-pay the restaurant.
              await stripe.transfers.create({
                amount: Math.round(transferDollars * 100),
                currency: 'usd',
                destination: connectedAccountId,
                ...(chargeId ? { source_transaction: chargeId } : {}),
                transfer_group: order.reference,
                metadata: { orderReference: order.reference, kind: 'native_invoice_payout' },
              }, { idempotencyKey: `native-invoice-transfer-${invoice.id}` })
            } catch (e) {
              console.error('[Webhook] native invoice payout transfer failed:', e instanceof Error ? e.message : e)
              await alertOps('native invoice paid but payout transfer failed', {
                invoiceId: invoice.id, orderReference: order.reference,
                error: e instanceof Error ? e.message : String(e),
              })
            }
          }
          // Customer + restaurant confirmations (shared, idempotent per order).
          waitUntil(dispatchOrderConfirmations(order.id, 'STRIPE_WEBHOOK'))
        }
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

      // ── account.updated (Connect) ──
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
        await notifyStripeConnectedIfNewlyFullyConnected(account)
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
