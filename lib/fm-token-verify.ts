/**
 * IS THIS FAMILYMEAL LOGIN TOKEN REAL? (22 Oct 2026)
 *
 * The admin portal (fm_admin_token) and the FM-session restaurant portal
 * (fm_restaurant_token) both used to DECODE the JWT and trust what it said —
 * role, email, home restaurant — without checking its signature. Disco cannot
 * check the signature itself (FamilyMeal holds the key), and any route that
 * writes only to Disco never shows the token to FamilyMeal, so a hand-made
 * cookie claiming SUPER_ADMIN (or any restaurant) was believed.
 *
 * This asks FamilyMeal to accept the token — a READ of the caller's own
 * profile — before anything inside it is trusted. A token FamilyMeal accepts
 * is one it signed, so its claims are then genuine. Expired tokens are refused
 * by FamilyMeal the same way.
 *
 * Positive answers are cached per token (5 min, capped below the token's own
 * expiry); refusals for 60s so a forged cookie cannot be used to hammer FM.
 * Network failure FAILS CLOSED: an unverifiable token is not trusted.
 */
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const OK_TTL_MS = 5 * 60 * 1000
const NO_TTL_MS = 60 * 1000
const cache = new Map<string, { ok: boolean; until: number }>()

export function decodeJwtUnverified(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

async function accepted(token: string, path: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(`${FM}${path}`, { headers: { Authorization: token }, cache: 'no-store', signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

/**
 * The token's claims if FamilyMeal accepts the token, else null.
 * `/api/users` (own profile) answers for every role; `/api/restaurants` (own
 * restaurant) is a second read for restaurant roles in case the first is not
 * served to them. Either 2xx proves the token is FamilyMeal's.
 */
export async function verifiedFmClaims(token: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!token) return null
  const payload = decodeJwtUnverified(token)
  if (!payload) return null
  const exp = Number(payload.exp || 0)
  if (exp && exp * 1000 <= Date.now()) return null

  const hit = cache.get(token)
  if (hit && hit.until > Date.now()) return hit.ok ? payload : null

  const ok = (await accepted(token, '/api/users')) || (await accepted(token, '/api/restaurants'))
  const ttl = ok ? Math.min(OK_TTL_MS, exp ? exp * 1000 - Date.now() : OK_TTL_MS) : NO_TTL_MS
  if (cache.size > 2000) cache.clear()
  cache.set(token, { ok, until: Date.now() + Math.max(ttl, 0) })
  return ok ? payload : null
}
