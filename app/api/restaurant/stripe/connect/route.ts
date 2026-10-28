import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { requireWritableRestaurantRef } from '../../../../../lib/restaurant-write-scope'
import { createConnectAccount, createAccountLink } from '../../../../../lib/stripe-connect'
import { sql, runMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.discocater.com'

// Money movement: this attaches/creates a Stripe payout account for a
// restaurant. The target is the client-claimed restaurant_reference (query
// param — this route has no body), verified against the caller's permitted
// set — never the session's current selection (see disco-profile's PUT for
// the full stale-intent rationale). Fails closed on any mismatch.
export async function POST(req: NextRequest) {
  const check = await requireWritableRestaurantRef(req.nextUrl.searchParams.get('restaurant_reference'))
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref

  // Disco-native: start Stripe Connect onboarding via Disco's own Stripe. Reuses
  // the location's connected account if one exists, else creates it. Returns the
  // hosted onboarding link (stripeConnectUrl) the banking page redirects to.
  //
  // KEYED ON THE RESTAURANT, NOT ON HOW THE CALLER SIGNED IN (28 Oct 2026). This
  // used to branch on ctx.authType === 'disco', so anyone signed in with their
  // FamilyMeal password — every owner without a Disco password, and our team on
  // the master password — was sent through FamilyMeal's connect endpoint with a
  // familymeal.com callback, even for a Disco location. Alex Karana (Stacks &
  // Cordials, FM-password login) clicked Connect twice and landed on FamilyMeal.
  // stripe-status already asks "is this restaurant native?"; this now asks the
  // same question, so status and action can't disagree.
  //
  // Not the swallowing isDiscoNativeRestaurant(): a lookup failure there reads as
  // "not native" and would route a Disco location to FamilyMeal. Here it fails.
  let isNative: boolean
  try {
    const nativeRows = (await sql`
      SELECT 1 FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} AND is_disco_native = true LIMIT 1
    `) as unknown[]
    isNative = nativeRows.length > 0
  } catch (e) {
    console.error('[stripe/connect] native lookup failed:', ref, e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to connect Stripe' }, { status: 500 })
  }
  if (isNative) {
    if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 })
    try {
      await runMigrations()
      // ── AN EMAIL FOR THE STRIPE ACCOUNT, NOT AN AUTHORISATION CHECK ───────
      // Access was already decided by requireWritableRestaurantRef above. This
      // only needs a contact address to hand createConnectAccount, and it used
      // to 404 "Account not found" when it could not find one.
      //
      // A COPIED LOCATION HAS NO ACCOUNT ROW OF ITS OWN, EVER. The copy route
      // creates a cache row, an overrides row, multi-unit membership and
      // location grants — but no account, and it cannot: account email is
      // UNIQUE fleet-wide, so the owner of the source already holds the only
      // row their address is allowed to have. 174 native restaurants are in
      // that state and every one of them was refused here.
      //
      // DELIBERATELY CONSERVATIVE. Tier 1 is the EXISTING query, unchanged —
      // same table, same ORDER BY id, same result — so for every restaurant
      // that already has an anchored row the chosen address is byte-for-byte
      // what it is today. Measured before building: of 487 native restaurants
      // with an anchored row, this changes the address for 0. The later tiers
      // are reachable ONLY when there are no anchored rows at all.
      const rows = (await sql`
        SELECT email FROM (
          -- 1. exactly today's behaviour
          SELECT a.email AS email, 1 AS tier, a.id AS ord
            FROM disco_restaurant_accounts a
           WHERE a.restaurant_reference = ${ref}
          UNION ALL
          -- 2. the restaurant's own nominated contact, when nobody is anchored
          SELECT o.contact_email, 2, 0
            FROM disco_restaurant_overrides o
           WHERE o.restaurant_reference = ${ref}
             AND o.contact_email IS NOT NULL AND o.contact_email <> ''
          UNION ALL
          -- 3. somebody who demonstrably has access to this location
          SELECT la.account_email, 3, la.id
            FROM disco_restaurant_location_access la
           WHERE la.restaurant_reference = ${ref}
        ) s
        ORDER BY tier ASC, ord ASC
        LIMIT 1
      `) as { email: string }[]
      if (!rows.length) {
        return NextResponse.json({
          error: 'No one is associated with this location yet, so there is no contact address for the Stripe account. Add a team member to it first.',
        }, { status: 404 })
      }
      const cacheRows = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as { name: string | null }[]
      const ovrRows = (await sql`SELECT stripe_account_id FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`) as { stripe_account_id: string | null }[]
      let accountId = ovrRows[0]?.stripe_account_id || ''
      if (!accountId) {
        accountId = await createConnectAccount(rows[0].email, cacheRows[0]?.name || 'Disco Restaurant', ref)
        await sql`
          INSERT INTO disco_restaurant_overrides (restaurant_reference, stripe_account_id, updated_at)
          VALUES (${ref}, ${accountId}, NOW())
          ON CONFLICT (restaurant_reference) DO UPDATE SET stripe_account_id = EXCLUDED.stripe_account_id, updated_at = NOW()
        `
      }
      const returnUrl = `${BASE_URL}/restaurant/account/banking`
      const stripeConnectUrl = await createAccountLink(accountId, returnUrl, returnUrl)
      return NextResponse.json({ stripeConnectUrl })
    } catch (e) {
      console.error('[stripe/connect] disco connect failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to connect Stripe' }, { status: 500 })
    }
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  // FM's stripe/clients/{ref}/connect endpoint DOES take an explicit
  // restaurantRef in the URL (unlike tax-rate/online-ordering's FM proxies) —
  // use the verified ref directly rather than whatever the session's current
  // selection happens to be.
  try {
    const res = await fetch(`${FM}/api/stripe/clients/${encodeURIComponent(ref)}/connect`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'callbackUri=https://familymeal.com/restaurant/account',
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to connect Stripe', raw: err }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to connect Stripe' }, { status: 500 })
  }
}
