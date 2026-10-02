// Find a restaurant's Stripe connected account AT CONVERSION TIME.
//
// ── WHY THIS REPLACES A FILE ────────────────────────────────────────────────
// Conversion used to take the account id from data/stripe-account-resolutions.json,
// a snapshot generated on 2026-09-08. Two things were wrong with that, and the
// second is the one that did the damage:
//
//  1. IT GOES STALE. It holds 655 accounts; the platform now has 668.
//
//  2. IT RESOLVES BY TRANSFER HISTORY. Each entry is bucketed by looking at the
//     account's past transfers to work out which restaurant it belongs to —
//     385 resolved, 265 "no-transfers", 5 "no-metadata". An account that has
//     never been paid out has no transfers, so it cannot be resolved at all,
//     and that is EXACTLY the population that converts: a restaurant connects
//     Stripe when it joins and only earns transfers once it trades.
//
//     Al Volo Gastronomia Italiana is the worked example. Its account
//     (acct_1TvLMh7MOjigvFNg, "Al Volo Pier 57 LLC", connected 2026-07-20 and
//     fully enabled) IS in the file — bucketed `no-transfers` with
//     restaurantReference: null. Conversion read null, linked nothing, and said
//     nothing. 212 restaurants are in that state, and NOT ONE of them appears
//     in the file's resolved bucket.
//
// ── WHAT THIS CAN AND CANNOT DO ─────────────────────────────────────────────
// FamilyMeal answers WHETHER a restaurant has an account (HEAD /api/stripe/{ref}
// → 204) but exposes no endpoint returning WHICH — GET on the same path answers
// "Request method 'GET' not supported", and the mapping lives only in FM's
// tbl_stripe_connected_accounts, inside a private network.
//
// So this resolves what it honestly can, and when FamilyMeal says an account
// exists that it cannot name, it says so rather than converting silently. That
// is the whole point: the previous behaviour was not "failed to link", it was
// "failed to link and reported success".
import Stripe from 'stripe'
import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export interface StripeLinkResolution {
  /** The account to link, or null when none could be named. */
  accountId: string | null
  /** FamilyMeal's own answer to "does this restaurant have a Stripe account". */
  fmHasAccount: boolean | null
  source: 'already-linked' | 'stripe-metadata' | 'fm-unresolvable' | 'none'
  /**
   * TRUE is the state this module exists to surface: FamilyMeal holds an
   * account, and we could not determine which one. The caller must NOT treat
   * the restaurant as payment-ready, and must not leave it listed.
   */
  needsManualLink: boolean
  note: string
}

/** FamilyMeal's yes/no. null when FM could not be asked. */
export async function fmHasStripeAccount(ref: string): Promise<boolean | null> {
  try {
    const h = await getFmServiceAuthHeader()
    const res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: h, cache: 'no-store' })
    if (res.status === 204) return true
    if (res.status === 404) return false
    return null
  } catch {
    return null
  }
}

/**
 * Resolve, in order of how much the answer can be trusted:
 *
 *  1. ALREADY LINKED in Disco — nothing to do, and never overwritten.
 *  2. STRIPE METADATA restaurantReference — set by Disco's own onboarding, so
 *     it is Disco's own record of the link and is exact. Only 14 of 668
 *     accounts carry it today, which is why it cannot be the whole answer.
 *  3. Nothing nameable. If FamilyMeal says an account exists, that is
 *     `needsManualLink` — a human confirms it in the Stripe dashboard.
 *
 * NAME MATCHING IS DELIBERATELY ABSENT. It was measured and it is not safe:
 * "Black Seed Bagels" matches an account called "Black Market BBQ LLC", and
 * "Family's Favorite Foods" matches "Family Meal Maiz". Several accounts are
 * named "FamilyMeal" or "FamilyMeal Concepts Inc" rather than the restaurant,
 * and real ones diverge ("Al Volo Gastronomia Italiana" / "Al Volo Pier 57
 * LLC"). A wrong link sends one restaurant's money to another business, so a
 * name is a lead for a human, never a basis for a write.
 */
export async function resolveStripeAccountForConversion(
  ref: string,
  opts?: { stripe?: Stripe },
): Promise<StripeLinkResolution> {
  const linked = (await sql`
    SELECT stripe_account_id FROM disco_restaurant_overrides
    WHERE restaurant_reference = ${ref} AND stripe_account_id IS NOT NULL LIMIT 1
  `.catch(() => [])) as { stripe_account_id: string }[]
  if (linked.length) {
    return {
      accountId: linked[0].stripe_account_id, fmHasAccount: null, source: 'already-linked',
      needsManualLink: false, note: 'Already linked in Disco Cater.',
    }
  }

  const stripe = opts?.stripe ?? new Stripe((process.env.STRIPE_READONLY_KEY || process.env.STRIPE_SECRET_KEY || '').replace(/^"|"$/g, ''))
  try {
    // A scan rather than accounts.search: search is not on this API version's
    // Account resource, and at 668 connected accounts a paged list is cheap and
    // needs no version pinning.
    const hits: Stripe.Account[] = []
    for await (const a of stripe.accounts.list({ limit: 100 })) {
      if (a.metadata?.restaurantReference === ref) hits.push(a)
    }
    if (hits.length === 1) {
      return {
        accountId: hits[0].id, fmHasAccount: null, source: 'stripe-metadata',
        needsManualLink: false, note: `Resolved from the account's own restaurantReference metadata.`,
      }
    }
    if (hits.length > 1) {
      return {
        accountId: null, fmHasAccount: await fmHasStripeAccount(ref), source: 'fm-unresolvable',
        needsManualLink: true,
        note: `${hits.length} Stripe accounts claim this restaurant reference — a human must choose.`,
      }
    }
  } catch { /* fall through to FamilyMeal's yes/no */ }

  const fmHas = await fmHasStripeAccount(ref)
  if (fmHas === true) {
    return {
      accountId: null, fmHasAccount: true, source: 'fm-unresolvable', needsManualLink: true,
      note: 'FamilyMeal holds a Stripe account for this restaurant but does not expose which one. Confirm it in the Stripe dashboard and link it before this restaurant goes live.',
    }
  }
  return {
    accountId: null, fmHasAccount: fmHas, source: 'none', needsManualLink: false,
    note: fmHas === false
      ? 'Neither Disco Cater nor FamilyMeal holds a Stripe account — this restaurant has genuinely never connected one.'
      : 'FamilyMeal could not be asked; treat as unknown rather than as "no account".',
  }
}
