import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

export const runtime = 'nodejs'

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook handler — BUILT BUT NOT YET ACTIVATED.
//
// The live Stripe webhooks still point at FM
// (api.familymeal.com/stripe/event/webhook). This endpoint is intentionally NOT
// registered in the Stripe Dashboard yet, so Stripe never calls it and it has
// ZERO effect on production. It exists so we can fill in the business logic
// (ported from the FM source) and flip the Dashboard webhook over when ready.
//
// For now every event is signature-verified, logged, and acked with 200.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Signature verification REQUIRES the raw request body. Do NOT use
  // request.json() — parsing/re-serializing changes the bytes and the signature
  // check will always fail.
  const body = await request.text()
  const sig = request.headers.get('stripe-signature')
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  if (!secret) {
    console.error('[Webhook] STRIPE_WEBHOOK_SECRET is not configured')
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
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

  // Log-only for now. Business logic will be ported from FM later. Every branch
  // (including default) falls through to a 200 so Stripe never retries.
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      console.log('[Webhook] Payment succeeded:', pi.id, pi.amount)
      break
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      console.log('[Webhook] Payment failed:', pi.id)
      break
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      console.log('[Webhook] Charge refunded:', charge.id, charge.amount_refunded)
      break
    }
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice
      console.log('[Webhook] Invoice paid:', invoice.id)
      break
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      console.log('[Webhook] Invoice payment failed:', invoice.id)
      break
    }
    case 'account.updated': {
      const account = event.data.object as Stripe.Account
      console.log('[Webhook] Connected account updated:', account.id, account.charges_enabled ? 'enabled' : 'pending')
      break
    }
    case 'payout.paid': {
      // For Connect events the connected account is on event.account.
      const payout = event.data.object as Stripe.Payout
      console.log('[Webhook] Payout paid:', payout.id, payout.amount, event.account)
      break
    }
    case 'payout.failed': {
      const payout = event.data.object as Stripe.Payout
      console.log('[Webhook] Payout failed:', payout.id, event.account)
      break
    }
    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription
      console.log('[Webhook] Subscription created:', sub.id)
      break
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      console.log('[Webhook] Subscription updated:', sub.id)
      break
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      console.log('[Webhook] Subscription cancelled:', sub.id)
      break
    }
    default:
      console.log('[Webhook] Unhandled event type:', event.type)
  }

  // Always 200 for verified events (including unhandled types) so Stripe does
  // not retry indefinitely.
  return NextResponse.json({ received: true }, { status: 200 })
}
