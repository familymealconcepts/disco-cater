import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { fmFetch } from './fm-fetch'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const RESTAURANT_TOKEN_COOKIE = 'fm_restaurant_token'
export const RESTAURANT_REFRESH_COOKIE = 'fm_restaurant_refresh'
export const SELECTED_RESTAURANT_COOKIE = 'fm_selected_restaurant'

export const RESTAURANT_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

// For Route Handlers — uses next/headers for reliable server-side access
export async function getRestaurantToken(): Promise<string | null> {
  const store = await cookies()
  return store.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
}

// Auth header helper — throws if token is missing
// FM API expects raw JWT: Authorization: <token> (no Bearer prefix)
export async function getRestaurantAuthHeader(): Promise<Record<string, string>> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) throw new Error('Not authenticated')
  return { Authorization: token }
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Decode the current user's reference from the JWT. FM's MultiUnitLinks DTOs
// require `userReference` to be a UUID, and FM's listing call validates it too.
// The JWT's `sub` claim is the user's EMAIL (e.g. "chef@familymeal.com"), NOT a
// UUID — sending it made FM reject both create-link and fetch-links. So we only
// accept a UUID-shaped user claim, and fall back to the restaurant UUID
// (getRestaurantRef) when the token carries no user UUID. Never returns the email.
export async function getRestaurantUserRef(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  const candidates = [payload?.reference, payload?.userReference, payload?.userRef, payload?.uid, payload?.id]
  for (const c of candidates) {
    if (typeof c === 'string' && UUID_RE.test(c)) return c
  }
  return await getRestaurantRef()
}

// Decode role from JWT payload field 'role'
export async function getRestaurantRole(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  return (payload?.role as string) || null
}

// The JWT's 'restaurant' claim (home), independent of any selected-restaurant
// cookie. Used where a caller needs the true home ref regardless of what's
// currently selected (e.g. validating a selection attempt against it).
export async function getRestaurantHomeRef(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  return (payload?.restaurant as string) || null
}

// SYSTEM_ADMIN's own switch-target list, cached briefly per-token — the
// FM-session twin of getDiscoGroupAccounts(). Never throws: any failure
// (network, non-2xx, unexpected shape) resolves to an empty (uncached) set so
// the caller falls back to home, same fail-closed contract resolveDiscoScopeRef
// uses for its own group lookup.
//
// NOT used for SUPER_ADMIN — see getRestaurantRef's comment on why that role
// never calls this endpoint at all.
//
// Cached 30s per JWT (mirrors getFmServiceToken's cache-until-near-expiry
// pattern in lib/fm-service-auth.ts) so a multi-location SYSTEM_ADMIN actively
// browsing a non-home location doesn't trigger this FM round-trip on every
// single request. Only a genuinely successful, well-formed response is cached —
// errors/non-2xx are never cached, so a real outage is retried on the very next
// call rather than being stuck fail-closed for the full TTL.
const fmPermittedRefsCache = new Map<string, { expiresAt: number; refs: Set<string> }>()
const FM_PERMITTED_REFS_TTL_MS = 30_000

export async function getFmSystemAdminPermittedRefs(token: string): Promise<Set<string>> {
  const now = Date.now()
  const cached = fmPermittedRefsCache.get(token)
  if (cached && now < cached.expiresAt) return cached.refs

  console.log('[getRestaurantRef] fetching FM system-admin/restaurants/list (permitted-set cache miss/expired)')
  try {
    const res = await fmFetch(`${FM}/api/system-admin/restaurants/list`, {
      headers: { Authorization: token },
    }, 5_000)
    if (!res.ok) return new Set()
    const list = (await res.json()) as Array<{ reference?: string }>
    if (!Array.isArray(list)) return new Set()
    const refs = new Set(list.map(r => r.reference).filter((r): r is string => typeof r === 'string' && !!r))
    fmPermittedRefsCache.set(token, { expiresAt: now + FM_PERMITTED_REFS_TTL_MS, refs })
    return refs
  } catch {
    return new Set()
  }
}

// Decode restaurant reference UUID.
//
// SUPER_ADMIN is unrestricted — matches FM's own authorization model exactly:
// FM's SYSTEM_ADMIN-only controller (api/system-admin/restaurants/*,
// @PreAuthorize("hasAuthority('SYSTEM_ADMIN')")) flatly denies SUPER_ADMIN
// (confirmed against a real SUPER_ADMIN account — FM returns a 500 "Access is
// denied"), while SUPER_ADMIN's own controller (api/admin/restaurants/*,
// @PreAuthorize("hasAuthority('SUPER_ADMIN')")) takes any restaurantReference
// directly with no per-restaurant ACL at all. So there is no "permitted list"
// to check SUPER_ADMIN against — the role itself is FM's authorization. Calling
// the SYSTEM_ADMIN list endpoint for a SUPER_ADMIN would always 500 and always
// fall back to home, silently breaking real cross-restaurant access.
//
// SYSTEM_ADMIN honors the selected-restaurant cookie ONLY if it names a
// restaurant FM's own system-admin/restaurants/list confirms this admin may
// manage — otherwise falls back to the 'restaurant' field on the JWT (home).
// This is the FM-session twin of resolveDiscoScopeRef
// (lib/restaurant-auth-context.ts) and MUST match its semantics exactly: never
// widen access, any doubt resolves to home. Plain ADMIN never trusts the
// cookie, same as before.
export async function getRestaurantRef(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  const role = (payload?.role as string) || ''
  const home = (payload?.restaurant as string) || null

  if (role === 'SUPER_ADMIN') {
    const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
    return selected || home
  }
  if (role !== 'SYSTEM_ADMIN') return home

  const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
  if (!selected || selected === home) return home

  const permitted = await getFmSystemAdminPermittedRefs(token)
  return permitted.has(selected) ? selected : home
}

// For Middleware (Edge runtime — next/headers not available)
export function getRestaurantTokenFromRequest(req: NextRequest): string | null {
  return req.cookies.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
}
