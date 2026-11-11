// Server-side half of the FamilyMeal-password rule (see lib/fm-portal-clearance.ts).
//
// middleware.ts already refuses an FM session with no valid clearance on every
// portal page and /api/restaurant/* route. This repeats that check inside the
// shared FM-session helpers (lib/restaurant-auth.ts, lib/restaurant-auth-context.ts)
// so a route outside the middleware matcher cannot be reached either, and adds the
// one thing the edge cannot do — re-ask, against Neon, whether this person's
// restaurants have moved to Disco since they signed in. If they have, the FM
// session stops working and the next sign-in asks for a Disco password.
//
// The team is never re-checked: a 'master' or 'super-admin' clearance is final.
import { cookies } from 'next/headers'
import { FM_PORTAL_CLEARANCE_COOKIE, verifyClearance, fmTokenEmail } from './fm-portal-clearance'
import { classifyFmRestaurantLogin } from './fm-login-scope'

const RECHECK_TTL_MS = 5 * 60 * 1000
const recheck = new Map<string, { ok: boolean; until: number }>()

/** True when this VERIFIED FM restaurant token may use the portal. */
export async function fmPortalSessionAllowed(token: string, claims: Record<string, unknown>): Promise<boolean> {
  const email = fmTokenEmail(token)
  let cookie: string | undefined
  try { cookie = (await cookies()).get(FM_PORTAL_CLEARANCE_COOKIE)?.value } catch { return false }
  const clearance = await verifyClearance(cookie, email)
  if (!clearance) return false
  if (clearance.kind === 'master' || clearance.kind === 'super-admin') return true

  const hit = recheck.get(token)
  if (hit && hit.until > Date.now()) return hit.ok
  try {
    const scope = await classifyFmRestaurantLogin({
      email,
      role: String(claims.role || ''),
      homeRef: claims.restaurant ? String(claims.restaurant) : null,
    })
    // 'team' cannot occur with an 'fm-backed' clearance unless FM changed the
    // role; it is the team either way, so it stays allowed.
    const ok = scope === 'fm-backed' || scope === 'team'
    if (recheck.size > 2000) recheck.clear()
    recheck.set(token, { ok, until: Date.now() + RECHECK_TTL_MS })
    return ok
  } catch (err) {
    // A Neon hiccup must not lock FamilyMeal-backed restaurants out of their
    // portal. The clearance was verified above and records a sign-in decision
    // made with this same rule, so it is honoured until the re-check can run.
    console.error('[fm-portal-gate] re-check failed, honouring the sign-in clearance:', err instanceof Error ? err.message : err)
    return true
  }
}
