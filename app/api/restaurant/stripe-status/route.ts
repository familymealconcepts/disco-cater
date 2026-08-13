import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { isChargesEnabled } from '../../../../lib/stripe-connect'
import { sql } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Whether the current restaurant has a working Stripe Connect account. Drives the
// "connect your bank account" warning in the portal (layout sidebar dot + Banking
// page).
//
// Disco-native partners connect Stripe via Disco's own Stripe (stored in Neon —
// FM never learns about it), so a Disco session checks Neon. Two fixes here:
//   RH6 — scope to the currently-SELECTED location (resolveDiscoScopeRef), the same
//         ref the Connect/Disconnect actions use, so status and actions never
//         disagree for a multi-location SYSTEM_ADMIN (was: the home location).
//   RH5 — lazily confirm onboarding: /stripe/connect stores the account id but
//         never sets stripe_onboarding_complete, so a freshly-connected restaurant
//         showed "disconnected" forever. When an account exists but completion
//         isn't recorded yet, do the live charges-enabled check (same as
//         become-a-partner/stripe-status) and persist it.
// Legacy FM-authenticated restaurants (no Disco session) still use the FM check.
export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()

  // ── Disco-native path ──
  if (ctx?.authType === 'disco') {
    try {
      const ref = await resolveDiscoScopeRef(ctx)
      if (ref) {
        const rows = (await sql`
          SELECT stripe_account_id, stripe_onboarding_complete
          FROM disco_restaurant_accounts
          WHERE restaurant_reference = ${ref}
          ORDER BY id ASC LIMIT 1
        `) as { stripe_account_id: string | null; stripe_onboarding_complete: boolean | null }[]
        const acct = rows[0]
        if (!acct?.stripe_account_id) return NextResponse.json({ connected: false, restaurant_reference: ref })
        // Already confirmed — no need to hit Stripe again.
        if (acct.stripe_onboarding_complete === true) return NextResponse.json({ connected: true, restaurant_reference: ref })
        // Account exists but completion isn't recorded (RH5): confirm live and persist.
        const enabled = await isChargesEnabled(acct.stripe_account_id).catch(() => false)
        if (enabled) {
          await sql`
            UPDATE disco_restaurant_accounts
            SET stripe_onboarding_complete = true, updated_at = NOW()
            WHERE restaurant_reference = ${ref}
          `.catch((e) => console.error('[restaurant/stripe-status] complete persist failed:', e instanceof Error ? e.message : e))
        }
        return NextResponse.json({ connected: enabled, restaurant_reference: ref })
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
    return NextResponse.json({ connected: res.ok, restaurant_reference: ref })
  } catch { return NextResponse.json({ connected: false, restaurant_reference: ref }) }
}
