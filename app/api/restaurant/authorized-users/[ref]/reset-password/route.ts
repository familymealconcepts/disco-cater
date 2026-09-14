import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { resolveResetEligibility, sendPasswordResetTo } from '../../../../../../lib/password-reset'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Reset an authorized user's password from the restaurant portal.
//
// THIS USED TO BE AN UNCONDITIONAL FM PROXY. Not a branch on the caller's
// session that happened to pick wrong — no branch at all: every restaurant,
// native or not, had its staff sent to FamilyMeal to set a password. For a
// Disco-native restaurant that is useless twice over: the login lives in Neon
// (disco_restaurant_accounts.password_hash), so setting a password in FM changes
// nothing they can log in with, and the email leads to a platform they are no
// longer on. Apollo Bagels' staff could not log in for exactly this reason.
//
// Ownership is resolved by resolveResetEligibility, which reads the AUTHORITATIVE
// disco_restaurant_cache.is_disco_native — never disco_restaurant_accounts'
// stale copy of the same flag, which silently misrouted real native restaurants
// once already (7436e7d).
//
// `email` comes from the request body because this route is keyed by FM's USER
// reference, which a native account does not have. The FM path is unchanged.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { ref } = await params

  let email = ''
  try {
    const body = await req.json().catch(() => null) as { email?: string } | null
    email = String(body?.email || '').trim()
  } catch { /* no body — fall through to the FM path below */ }

  if (email) {
    const elig = await resolveResetEligibility(email)
    if (elig.eligible) {
      // A Disco-owned login: send OUR reset, landing on /restaurant/accept-invite.
      const outcome = await sendPasswordResetTo(elig.target, { source: 'self-service', actorEmail: ctx.email || null })
      if (!outcome.ok) {
        return NextResponse.json({ error: outcome.message || 'Could not send the reset email.' }, { status: outcome.code === 'rate-limited' ? 429 : 502 })
      }
      return NextResponse.json({ ok: true, native: true })
    }
    // Not a Disco-owned login (FM-backed restaurant, or no Neon account yet) —
    // fall through to FM, which is the correct owner in that case.
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/users/${ref}/reset-password`, { method: 'PUT', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true, native: false })
  } catch { return NextResponse.json({ error: 'Unable to reset password' }, { status: 500 }) }
}
