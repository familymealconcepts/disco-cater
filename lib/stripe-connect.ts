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
    // Default new restaurants to AUTOMATIC WEEKLY payouts on MONDAY, 2-day rolling
    // basis. interval:'weekly' (not 'manual') means Stripe pays out automatically on
    // the schedule; weekly_anchor:'monday' anchors the payout to Mondays; delay_days:2
    // is the US minimum funds-availability window. Set at creation so every
    // Disco-onboarded account inherits it — Disco is the sole creator of new connected
    // accounts, and there is no accounts.update anywhere, so EXISTING accounts are
    // intentionally never touched (this only changes the default going forward).
    settings: {
      payouts: {
        schedule: { interval: 'weekly', weekly_anchor: 'monday', delay_days: 2 },
      },
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

// ── Payout schedule (M9) ─────────────────────────────────────────────────────
// View/change a Disco-native connected account's automatic-payout schedule from
// the super-admin Edit Restaurant tool (previously only settable in Stripe's own
// dashboard). Disco-native only — the caller gates on is_disco_native; FM-backed
// restaurants' payouts stay FM-managed. Stripe is injectable for testing.

export type PayoutInterval = 'manual' | 'daily' | 'weekly' | 'monthly'
export const PAYOUT_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

export interface PayoutScheduleInput {
  interval: PayoutInterval
  weeklyAnchor?: string   // weekly only
  monthlyAnchor?: number  // monthly only, 1-31
  delayDays?: number      // daily/weekly/monthly; US minimum is 2
}

export interface PayoutSchedule {
  interval: PayoutInterval
  weeklyAnchor: string | null
  monthlyAnchor: number | null
  delayDays: number | null
}

const MIN_DELAY_DAYS = 2   // US funds-availability minimum
const MAX_DELAY_DAYS = 30

// Pure: turn our input into the Stripe schedule object, sending ONLY the anchor
// fields valid for the chosen interval (Stripe rejects e.g. weekly_anchor on a
// daily schedule). Clamps delay_days / anchors into valid ranges.
export function buildScheduleUpdate(input: PayoutScheduleInput): Record<string, unknown> {
  const interval = input.interval
  if (!['manual', 'daily', 'weekly', 'monthly'].includes(interval)) {
    throw new Error(`Invalid payout interval: ${interval}`)
  }
  if (interval === 'manual') return { interval: 'manual' }

  const rawDelay = Math.round(Number(input.delayDays ?? MIN_DELAY_DAYS))
  const delay_days = Number.isFinite(rawDelay) ? Math.min(MAX_DELAY_DAYS, Math.max(MIN_DELAY_DAYS, rawDelay)) : MIN_DELAY_DAYS

  if (interval === 'daily') return { interval: 'daily', delay_days }
  if (interval === 'weekly') {
    const wa = String(input.weeklyAnchor || '').toLowerCase()
    const weekly_anchor = (PAYOUT_WEEKDAYS as readonly string[]).includes(wa) ? wa : 'monday'
    return { interval: 'weekly', weekly_anchor, delay_days }
  }
  // monthly
  const rawAnchor = Math.round(Number(input.monthlyAnchor ?? 1))
  const monthly_anchor = Number.isFinite(rawAnchor) ? Math.min(31, Math.max(1, rawAnchor)) : 1
  return { interval: 'monthly', monthly_anchor, delay_days }
}

// Normalize Stripe's account.settings.payouts.schedule into our shape.
function normalizeSchedule(s: unknown): PayoutSchedule {
  const o = (s ?? {}) as Record<string, unknown>
  const interval = (['manual', 'daily', 'weekly', 'monthly'].includes(String(o.interval)) ? o.interval : 'manual') as PayoutInterval
  return {
    interval,
    weeklyAnchor: typeof o.weekly_anchor === 'string' ? o.weekly_anchor : null,
    monthlyAnchor: typeof o.monthly_anchor === 'number' ? o.monthly_anchor : null,
    delayDays: typeof o.delay_days === 'number' ? o.delay_days : null,
  }
}

export async function getPayoutSchedule(
  accountId: string,
  stripe: Stripe = getStripe(),
): Promise<{ schedule: PayoutSchedule; chargesEnabled: boolean }> {
  const acct = await stripe.accounts.retrieve(accountId)
  return {
    schedule: normalizeSchedule(acct.settings?.payouts?.schedule),
    chargesEnabled: acct.charges_enabled === true,
  }
}

export async function updatePayoutSchedule(
  accountId: string,
  input: PayoutScheduleInput,
  stripe: Stripe = getStripe(),
): Promise<PayoutSchedule> {
  const schedule = buildScheduleUpdate(input)
  const acct = await stripe.accounts.update(
    accountId,
    { settings: { payouts: { schedule } } } as unknown as Stripe.AccountUpdateParams,
  )
  return normalizeSchedule(acct.settings?.payouts?.schedule)
}
