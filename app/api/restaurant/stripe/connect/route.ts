import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
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
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 })
    try {
      await runMigrations()
      const rows = (await sql`
        SELECT email FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref} ORDER BY id ASC LIMIT 1
      `) as { email: string }[]
      if (!rows.length) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
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
