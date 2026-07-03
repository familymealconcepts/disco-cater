import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { validateDiscoRestaurantSession, DISCO_RESTAURANT_COOKIE } from '../../../../lib/disco-restaurant-auth'
import { sql } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Whether the current restaurant has a working Stripe Connect account. Drives the
// "connect your bank account" warning in the portal (layout sidebar dot + Banking
// page).
//
// Disco-native partners connect Stripe during become-a-partner onboarding, which
// stores the account in Neon (disco_restaurant_accounts) — FM never learns about
// it. So we MUST check Neon first for a Disco session; falling straight through to
// FM would always report "not connected" for these restaurants. Legacy
// FM-authenticated restaurants (no Disco session) still use the FM check.
export async function GET(req: NextRequest) {
  // ── Disco-native path: read Stripe status straight from Neon. ──
  const discoToken = req.cookies.get(DISCO_RESTAURANT_COOKIE)?.value
  if (discoToken) {
    try {
      const session = await validateDiscoRestaurantSession(discoToken)
      if (session?.restaurantReference) {
        const rows = (await sql`
          SELECT stripe_account_id, stripe_onboarding_complete
          FROM disco_restaurant_accounts
          WHERE restaurant_reference = ${session.restaurantReference}
          ORDER BY id ASC LIMIT 1
        `) as { stripe_account_id: string | null; stripe_onboarding_complete: boolean | null }[]
        const acct = rows[0]
        // Matches the become-a-partner/stripe-status semantics: connected once an
        // account exists AND onboarding completed (charges enabled).
        const connected = !!acct?.stripe_account_id && acct?.stripe_onboarding_complete === true
        return NextResponse.json({ connected })
      }
    } catch (err) {
      console.error('[restaurant/stripe-status] disco lookup failed:', err instanceof Error ? err.message : err)
      // Fall through to the FM path rather than falsely reporting disconnected.
    }
  }

  // ── Legacy FM path: HEAD the FM Stripe endpoint. ──
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch { return NextResponse.json({ connected: false }) }
  const refParam = req.nextUrl.searchParams.get('ref')
  const ref = refParam || await getRestaurantRef()
  if (!ref) return NextResponse.json({ connected: false })
  try {
    const res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: h })
    return NextResponse.json({ connected: res.ok })
  } catch { return NextResponse.json({ connected: false }) }
}
