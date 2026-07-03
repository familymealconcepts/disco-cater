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
export async function getRestaurantPayoutConfig(restaurantReference: string): Promise<RestaurantPayoutConfig> {
  const acctRows = (await sql`
    SELECT stripe_account_id FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${restaurantReference} AND stripe_account_id IS NOT NULL
    ORDER BY id ASC LIMIT 1
  `.catch(() => [])) as { stripe_account_id: string | null }[]
  const ovrRows = (await sql`
    SELECT withhold_payouts FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantReference} LIMIT 1
  `.catch(() => [])) as { withhold_payouts: boolean | null }[]
  return {
    connectedAccountId: acctRows[0]?.stripe_account_id ?? null,
    withholdPayouts: ovrRows[0]?.withhold_payouts === true,
  }
}

export interface NativePaymentParams {
  totalDollars: number      // customer charge
  transferDollars: number   // restaurant payout
  connectedAccountId: string | null
  withholdPayouts: boolean
  customerId?: string
  paymentMethodId?: string  // set for server-side confirm (tests); omit for client-side confirm
  onBehalfOf?: boolean       // restaurant as merchant-of-record (production); omit for the test account
  metadata?: Record<string, string>
  description?: string
}

// Build the destination-charge PaymentIntent. When withheld (or no connected
// account), transfer_data is omitted so the whole charge stays on the platform.
export async function createNativeOrderPaymentIntent(stripe: Stripe, p: NativePaymentParams): Promise<Stripe.PaymentIntent> {
  const routeToRestaurant = !p.withholdPayouts && !!p.connectedAccountId
  const params: Stripe.PaymentIntentCreateParams = {
    amount: cents(p.totalDollars),
    currency: 'usd',
    ...(p.description ? { description: p.description } : {}),
    ...(p.metadata ? { metadata: p.metadata } : {}),
    ...(p.customerId ? { customer: p.customerId } : {}),
    ...(p.paymentMethodId ? { payment_method: p.paymentMethodId } : {}),
    ...(routeToRestaurant
      ? { transfer_data: { destination: p.connectedAccountId as string, amount: cents(p.transferDollars) } }
      : {}),
    ...(routeToRestaurant && p.onBehalfOf ? { on_behalf_of: p.connectedAccountId as string } : {}),
    // Client-side confirm flow (no payment_method supplied) needs a client_secret
    // with automatic payment methods; server-side confirm (tests) supplies the PM.
    ...(p.paymentMethodId ? {} : { automatic_payment_methods: { enabled: true } }),
  }
  return stripe.paymentIntents.create(params)
}
