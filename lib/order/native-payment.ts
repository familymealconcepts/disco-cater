// Native (zero-FM) order payment: a Stripe destination charge on the platform
// account that routes the restaurant's payout to its connected account and keeps
// Disco's cut (total − transfer) on the platform. Merchant-of-record is the
// restaurant (on_behalf_of), matching the FM DIRECT model.
//
// Money rules (see docs/native-menu-parity-plan.md 1f):
//   customer charged  = breakdown.total   (cents)
//   restaurant payout = breakdown.transfer (cents)  → transfer_data.amount
//   Disco keeps       = total − transfer            (stays on the platform)
//   withhold_payouts  → OMIT transfer_data: the whole charge stays on the platform
//                       (funds held with Disco); the order still completes. The
//                       intended payout is recorded on disco_sale_transactions for
//                       a later manual release.

import Stripe from 'stripe'
import { sql } from '../db'
import { cents } from '../promo-pricing'

export const STRIPE_API_VERSION = '2025-01-27.acacia'

export function stripeClient(secretKey: string | undefined): Stripe | null {
  if (!secretKey) return null
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION } as unknown as ConstructorParameters<typeof Stripe>[1])
}

export interface RestaurantPayoutConfig {
  connectedAccountId: string | null
  withholdPayouts: boolean
}

// Resolve a restaurant's Stripe connected account + payout-hold flag from Neon.
// Restaurant archiving (lib/disco-restaurant-archive.ts) MUST NEVER write
// withhold_payouts or stripe_account_id, and must never interrupt an in-flight
// PaymentIntent or pending transfer — archiving hides a storefront and portal
// access, not money. A pending payout for an archived restaurant completes
// normally. (In practice an archived restaurant's checkout is already
// unreachable — the storefront is gone — so this function simply won't be
// called for new orders; it stays untouched for the same reason existing
// orders' refunds still work after Stripe is disconnected.)
export async function getRestaurantPayoutConfig(restaurantReference: string): Promise<RestaurantPayoutConfig> {
  const ovrRows = (await sql`
    SELECT stripe_account_id, withhold_payouts FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantReference} LIMIT 1
  `.catch(() => [])) as { stripe_account_id: string | null; withhold_payouts: boolean | null }[]
  return {
    connectedAccountId: ovrRows[0]?.stripe_account_id ?? null,
    withholdPayouts: ovrRows[0]?.withhold_payouts === true,
  }
}

export interface NativePaymentParams {
  totalDollars: number      // customer charge
  transferDollars: number   // restaurant payout
  connectedAccountId: string | null
  withholdPayouts: boolean
  customerId?: string
  receiptEmail?: string      // diner email → shown on the charge + Stripe receipt
  paymentMethodId?: string  // set for server-side confirm (tests); omit for client-side confirm
  onBehalfOf?: boolean       // restaurant as merchant-of-record (production); omit for the test account
  confirm?: boolean          // confirm immediately server-side (recurring/off-session); omit for client confirm
  offSession?: boolean       // customer not present (recurring auto-charge)
  metadata?: Record<string, string>
  description?: string
}

// Resolve (or create) the platform-account Stripe Customer for a diner, keyed by
// email, so the destination charge is attached to a real Customer object instead
// of showing no customer in the Stripe dashboard. Reuses a stored id when we have
// one, else an existing Stripe customer with that email, else creates a new one.
// Best-effort and never throws — returns null if Stripe/Neon are unavailable so
// order placement still proceeds (the charge just won't carry a Customer).
export async function getOrCreateStripeCustomer(stripe: Stripe, email: string | null | undefined, name?: string | null): Promise<string | null> {
  const e = String(email || '').trim().toLowerCase()
  if (!e) return null
  // 1) Reuse a previously-stored Stripe customer id for this diner.
  try {
    const rows = (await sql`SELECT stripe_customer_id FROM disco_customers WHERE email = ${e} AND stripe_customer_id IS NOT NULL LIMIT 1`) as { stripe_customer_id: string | null }[]
    if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id
  } catch { /* column may not exist yet — fall through to Stripe */ }
  // 2) Reuse an existing Stripe customer with this email, else create one.
  let id: string | null = null
  try {
    const found = await stripe.customers.list({ email: e, limit: 1 })
    id = found.data[0]?.id ?? null
  } catch { /* fall through to create */ }
  if (!id) {
    try {
      const c = await stripe.customers.create({ email: e, ...(name ? { name } : {}) })
      id = c.id
    } catch { return null }
  }
  // 3) Persist for reuse (best-effort; no-op if the column isn't there yet).
  if (id) { try { await sql`UPDATE disco_customers SET stripe_customer_id = ${id} WHERE email = ${e}` } catch { /* best-effort */ } }
  return id
}

// Build the destination-charge PaymentIntent. When withheld (or no connected
// account), transfer_data is omitted so the whole charge stays on the platform.
export async function createNativeOrderPaymentIntent(stripe: Stripe, p: NativePaymentParams, idempotencyKey?: string): Promise<Stripe.PaymentIntent> {
  const routeToRestaurant = !p.withholdPayouts && !!p.connectedAccountId
  const params: Stripe.PaymentIntentCreateParams = {
    amount: cents(p.totalDollars),
    currency: 'usd',
    ...(p.description ? { description: p.description } : {}),
    ...(p.metadata ? { metadata: p.metadata } : {}),
    ...(p.customerId ? { customer: p.customerId } : {}),
    ...(p.receiptEmail ? { receipt_email: p.receiptEmail } : {}),
    ...(p.paymentMethodId ? { payment_method: p.paymentMethodId } : {}),
    // Server-side confirm for off-session recurring charges (B1). Omitted for the
    // client-confirm one-time flow, so that path is byte-for-byte unchanged.
    ...(p.confirm ? { confirm: true } : {}),
    ...(p.offSession ? { off_session: true } : {}),
    ...(routeToRestaurant
      ? { transfer_data: { destination: p.connectedAccountId as string, amount: cents(p.transferDollars) } }
      : {}),
    ...(routeToRestaurant && p.onBehalfOf ? { on_behalf_of: p.connectedAccountId as string } : {}),
    // Native checkout is ALWAYS a card charge — confirmed client-side via Stripe.js
    // confirmCardPayment, or server-side with a supplied payment_method (tests).
    // Use an explicit card-only PaymentIntent: automatic_payment_methods breaks the
    // legacy confirmCardPayment on an on_behalf_of PI (it returns an error even
    // though the charge succeeds, so the client showed a false failure and never
    // reached the confirmation screen — Bug 1).
    payment_method_types: ['card'],
  }
  return stripe.paymentIntents.create(params, idempotencyKey ? { idempotencyKey } : undefined)
}
