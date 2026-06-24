// Native Stripe Connect (Express) helpers for Disco-native restaurant payouts.
//
// Unlike the legacy flow (which proxied Connect onboarding to the FM API), these
// create the Connect account + onboarding link directly via the Stripe SDK, so a
// Disco-native partner never touches FM. Matches the inline-`new Stripe()` /
// apiVersion convention used across the codebase (there is no lib/stripe).

import Stripe from 'stripe'

function getStripe(): Stripe {
  return new Stripe(
    process.env.STRIPE_SECRET_KEY || '',
    { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1],
  )
}

// Create an Express connected account for a restaurant. Returns the acct_xxx id.
export async function createConnectAccount(email: string, businessName: string): Promise<string> {
  const stripe = getStripe()
  const account = await stripe.accounts.create({
    type: 'express',
    email: email || undefined,
    business_profile: {
      name: businessName || undefined,
      product_description: 'Catering orders via Disco Cater',
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { source: 'disco-become-a-partner' },
  })
  return account.id
}

// Hosted onboarding link for the Express account. refresh_url is hit if the link
// expires before completion; return_url is where Stripe sends them when done.
export async function createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<string> {
  const stripe = getStripe()
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: refreshUrl,
    return_url: returnUrl,
  })
  return link.url
}

// True once the account can accept charges (i.e. onboarding is effectively done).
export async function isChargesEnabled(accountId: string): Promise<boolean> {
  const stripe = getStripe()
  const acct = await stripe.accounts.retrieve(accountId)
  return acct.charges_enabled === true
}
