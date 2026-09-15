import Stripe from 'stripe'
import { sql, runStripeCapabilityMigrations } from './db'
import { classifyStripeAccount } from './stripe-account-status'

/**
 * Refresh the stored Stripe capability snapshot for every attached account.
 *
 * ── WHY THE ANSWER IS STORED AND NOT ASKED LIVE ───────────────────────────────
 * The public /locations/{slug} page must not render a location whose Order button
 * would fail, which means it needs to know whether Stripe has restricted the
 * account. Asking Stripe at render time would be one API call PER MEMBER on a
 * customer-facing, cached page — EggBred alone would be 19. So the answer is
 * computed here on a schedule and read from the row for free.
 *
 * ── ONE SOURCE, SO THE TWO SCREENS CANNOT DISAGREE ────────────────────────────
 * The super-admin Ordering column reads these same columns. Before this, the
 * admin screen asked Stripe live and the public page inferred from
 * stripe_account_id being non-null, so the two could — and did — say different
 * things about the same restaurant. Now both read one row written by one job.
 *
 * ── WHAT COUNTS AS "CAN SELL" ─────────────────────────────────────────────────
 * CHARGES, NOT PAYOUTS. An account with charges_enabled = false cannot take the
 * customer's money at all, so the order fails and the location is hidden. An
 * account that takes charges but cannot pay out STAYS VISIBLE: the order
 * succeeds, the customer is served, and the money is held by Stripe until the
 * restaurant satisfies whatever is outstanding — recoverable, not lost. Three
 * accounts are in exactly that state today (BurgerFi - Boynton Beach, Cotton's
 * Place, Hungry House) and hiding them would cancel real, completable orders to
 * protect against a problem the customer never experiences.
 *
 * ── MEMBERSHIP IS NEVER TOUCHED ───────────────────────────────────────────────
 * This writes capability only. A restricted location stays a link member and
 * reappears on the page by itself the moment Stripe clears it, exactly like the
 * online-ordering case. Nothing here removes anyone from anything.
 */
export interface CapabilityRefreshSummary {
  checked: number
  changed: number
  restricted: number
  atRisk: number
  connected: number
  unknown: number
  flips: { restaurantReference: string; from: string | null; to: string }[]
}

const CONCURRENCY = 8

export async function refreshStripeCapabilities(stripe: Stripe): Promise<CapabilityRefreshSummary> {
  await runStripeCapabilityMigrations()
  const rows = (await sql`
    SELECT restaurant_reference, stripe_account_id, stripe_status
      FROM disco_restaurant_overrides
     WHERE stripe_account_id IS NOT NULL
  `) as { restaurant_reference: string; stripe_account_id: string; stripe_status: string | null }[]

  const s: CapabilityRefreshSummary = {
    checked: 0, changed: 0, restricted: 0, atRisk: 0, connected: 0, unknown: 0, flips: [],
  }

  let i = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    for (;;) {
      const idx = i++
      if (idx >= rows.length) return
      const row = rows[idx]
      let state = 'unknown', reason: string | null = null
      let charges: boolean | null = null, payouts: boolean | null = null
      try {
        const acct = await stripe.accounts.retrieve(row.stripe_account_id)
        const c = classifyStripeAccount(acct)
        state = c.state; reason = c.reason
        charges = acct.charges_enabled === true
        payouts = acct.payouts_enabled === true
      } catch (e) {
        // An account Stripe will not return is an OPEN QUESTION, not a restriction.
        // Leave charges/payouts NULL — the page treats NULL as "do not hide",
        // because hiding a restaurant on the strength of a failed API call would
        // take a working storefront offline over a network blip.
        reason = e instanceof Error ? e.message.slice(0, 200) : 'unreadable'
      }
      s.checked++
      if (state === 'restricted') s.restricted++
      else if (state === 'at-risk') s.atRisk++
      else if (state === 'connected') s.connected++
      else s.unknown++
      if (row.stripe_status !== state) {
        s.changed++
        s.flips.push({ restaurantReference: row.restaurant_reference, from: row.stripe_status, to: state })
      }
      await sql`
        UPDATE disco_restaurant_overrides
           SET stripe_charges_enabled = ${charges}, stripe_payouts_enabled = ${payouts},
               stripe_status = ${state}, stripe_status_reason = ${reason},
               stripe_status_checked_at = NOW()
         WHERE restaurant_reference = ${row.restaurant_reference}
      `.catch(() => {})
    }
  }))
  return s
}
