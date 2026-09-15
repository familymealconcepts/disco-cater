import type Stripe from 'stripe'

/**
 * Stripe Connect account status, as the super-admin Ordering screen shows it.
 *
 * ── WHY THREE STATES AND NOT TWO ──────────────────────────────────────────────
 * The column showed only Connected / Not connected, which collapses two
 * situations that need OPPOSITE actions from whoever is looking:
 *
 *   no account at all  -> somebody has to onboard or attach one. Nothing exists.
 *   account RESTRICTED -> the account exists and Stripe has stopped it. Usually
 *                         the restaurant has to supply a document; sometimes only
 *                         Stripe can act.
 *
 * Reading "Not connected" against a restricted account sends you looking for an
 * account that is already there.
 *
 * ── WHAT STRIPE ACTUALLY EXPOSES, measured live against real accounts ─────────
 * Four fields carry the signal, and they do not agree with each other in the way
 * you would expect:
 *
 *   charges_enabled / payouts_enabled   can the account take money / be paid
 *   requirements.disabled_reason        WHY Stripe stopped it, when it has
 *   requirements.past_due[]             what is overdue RIGHT NOW
 *   requirements.pending_verification[] what Stripe is reviewing
 *
 * The important discovery is that PAST_DUE AND CHARGES_ENABLED ARE INDEPENDENT.
 * acct_1HIItbKZUc8hF6Bt (EggBred - La Habra) has charges_enabled = true,
 * payouts_enabled = true, disabled_reason = null AND a past_due requirement
 * (individual.verification.proof_of_liveness). It works today and Stripe will
 * restrict it when the deadline passes. Treating charges_enabled as the whole
 * answer hides that entirely; treating any past_due as "restricted" would wrongly
 * mark a working account as broken.
 *
 * So `at-risk` is its own state: takes money now, will not for long.
 *
 * ── WHY IT IS NOT FIXABLE FROM A STORED FLAG ──────────────────────────────────
 * disco_restaurant_overrides holds stripe_account_id and a stripe_connected
 * boolean probed at some past moment. Neither can express "restricted", and the
 * boolean goes stale silently — an account restricted an hour ago still reads
 * connected. This is read LIVE from Stripe per account, because the question
 * ("can this restaurant take an order right now") is only ever answerable now.
 */
export type StripeAccountState =
  | 'connected'      // charges + payouts on, nothing overdue
  | 'at-risk'        // works today, but a requirement is past due
  | 'restricted'     // Stripe has disabled charges and/or payouts
  | 'no-account'     // nothing attached in Disco
  | 'unknown'        // attached, but Stripe could not be read

export interface StripeAccountStatus {
  state: StripeAccountState
  /** One short human sentence. Rendered on hover in the admin column. */
  reason: string | null
  /** True only when the account can take a payment right now. */
  chargeCapable: boolean
  accountId: string | null
}

/** Turn a Stripe requirement key into something a person can act on. */
function humanRequirement(key: string): string {
  const k = key.replace(/^person_[^.]+\./, '').replace(/^individual\./, '').replace(/^company\./, '').replace(/^business_profile\./, '')
  const map: Record<string, string> = {
    'verification.proof_of_liveness': 'identity verification (proof of liveness)',
    'verification.document': 'an identity document',
    'tos_acceptance.date': 'Stripe terms acceptance',
    'tos_acceptance.ip': 'Stripe terms acceptance',
    'support_phone': 'a support phone number',
    'url': 'a business website',
    'phone': 'a business phone number',
  }
  return map[k] || k.replace(/[._]/g, ' ')
}

/**
 * Classify one live Stripe account. Order matters: a disabled account is
 * restricted whatever else is true, and only an account that is BOTH enabled and
 * clear of overdue requirements counts as connected.
 */
export function classifyStripeAccount(a: Stripe.Account): StripeAccountStatus {
  const req = a.requirements
  const pastDue = req?.past_due ?? []
  const pending = req?.pending_verification ?? []
  const disabled = req?.disabled_reason ?? null
  const id = a.id

  // 1. Stripe has actually stopped it.
  if (!a.charges_enabled || !a.payouts_enabled) {
    let reason: string
    if (disabled === 'requirements.past_due' || pastDue.length) {
      reason = `Stripe restricted this account — overdue: ${pastDue.slice(0, 3).map(humanRequirement).join(', ')}. The restaurant can fix this in Stripe.`
    } else if (disabled === 'requirements.pending_verification' || pending.length) {
      reason = 'Stripe is reviewing this account. Nothing to do but wait — the restaurant cannot speed this up.'
    } else if (disabled === 'rejected.fraud' || disabled === 'rejected.terms_of_service' || String(disabled || '').startsWith('rejected.')) {
      reason = `Stripe rejected this account (${disabled}). Only Stripe can reverse this.`
    } else if (disabled === 'under_review') {
      reason = 'Stripe has this account under review. Only Stripe can clear it.'
    } else if (!a.details_submitted) {
      reason = 'Onboarding was never completed — the restaurant has not finished Stripe signup.'
    } else {
      reason = disabled ? `Stripe restricted this account (${disabled}).` : 'Stripe has disabled charges or payouts on this account.'
    }
    // Distinguish charges-off from payouts-off, since they differ operationally:
    // no charges means no orders at all; no payouts means orders work but money
    // does not reach the restaurant.
    if (a.charges_enabled && !a.payouts_enabled) {
      reason = `Payouts are blocked (orders still work, money is being held). ${reason}`
    }
    return { state: 'restricted', reason, chargeCapable: !!a.charges_enabled, accountId: id }
  }

  // 2. Works now, but on a clock. See the header — this is a real, distinct state.
  if (pastDue.length) {
    return {
      state: 'at-risk',
      reason: `Working now, but Stripe will restrict this account — overdue: ${pastDue.slice(0, 3).map(humanRequirement).join(', ')}.`,
      chargeCapable: true,
      accountId: id,
    }
  }

  return { state: 'connected', reason: null, chargeCapable: true, accountId: id }
}
