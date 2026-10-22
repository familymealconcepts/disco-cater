import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { fmFetch } from './fm-fetch'
import { verifiedFmClaims } from './fm-token-verify'
import { sql } from './db'

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
// ── THE FM RESTAURANT TOKEN IS VERIFIED BEFORE ANYTHING IN IT IS TRUSTED ──────
// (22 Oct 2026) Every helper below used to DECODE fm_restaurant_token and
// believe its claims — role, home restaurant, email — without checking the
// signature. Routes that work only on Disco's own data (native menus, orders,
// settings, team) never show the token to FamilyMeal, so a hand-made cookie
// claiming role SUPER_ADMIN plus a selected-restaurant cookie reached any
// native restaurant's portal data, and one claiming {role: ADMIN, restaurant:
// X} reached restaurant X. Now FamilyMeal must accept the token first
// (lib/fm-token-verify.ts); a forged or expired token yields no claims, no
// header and no context. A real login's role and reach are unchanged.
export async function getRestaurantToken(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
  return (await verifiedFmClaims(token)) ? token : null
}

// Auth header helper — throws unless the token is present AND FamilyMeal
// accepts it. FM API expects raw JWT: Authorization: <token> (no Bearer prefix)
export async function getRestaurantAuthHeader(): Promise<Record<string, string>> {
  const token = await getRestaurantToken()
  if (!token) throw new Error('Not authenticated')
  return { Authorization: token }
}

/** The VERIFIED claims of the FM restaurant token, or null. */
async function decodeJwt(token: string): Promise<Record<string, unknown> | null> {
  return verifiedFmClaims(token)
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
  const payload = await decodeJwt(token)
  const candidates = [payload?.reference, payload?.userReference, payload?.userRef, payload?.uid, payload?.id]
  for (const c of candidates) {
    if (typeof c === 'string' && UUID_RE.test(c)) return c
  }
  return await getRestaurantRef()
}

/**
 * The FamilyMeal user's EMAIL, from the JWT's `sub` claim.
 *
 * getRestaurantUserRef deliberately never returns this — it needs a UUID and
 * FM rejects an email there. This is the opposite need: identifying the PERSON
 * behind an FM session, which getRestaurantAuthContext leaves blank (ctx.email
 * is '' for every FM session). Used where a surface has to say who is acting.
 */
export async function getRestaurantEmail(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = await decodeJwt(token)
  for (const c of [payload?.sub, payload?.email, payload?.user_name]) {
    if (typeof c === 'string' && c.includes('@')) return c.trim().toLowerCase()
  }
  return null
}

// Decode role from JWT payload field 'role'
export async function getRestaurantRole(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = await decodeJwt(token)
  return (payload?.role as string) || null
}

// The JWT's 'restaurant' claim (home), independent of any selected-restaurant
// cookie. Used where a caller needs the true home ref regardless of what's
// currently selected (e.g. validating a selection attempt against it).
export async function getRestaurantHomeRef(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = await decodeJwt(token)
  return (payload?.restaurant as string) || null
}

// ── A FAMILYMEAL-PASSWORD SYSTEM ADMIN REACHES DISCO'S LIST (22 Oct 2026) ─────
// Peter's rule: Disco's single location list decides which locations EVERY
// System Admin reaches, whichever password they sign in with. This used to be
// FamilyMeal's own list (GET /api/system-admin/restaurants/list) PLUS every
// Disco-native location sharing a multi-unit link page with it
// (lib/native-selection-scope.ts, now deleted). That link-page rule handed
// 806 grants across businesses — Happy's Pizza franchise stores each reaching
// ~55 other stores, store logins reaching other operators of their brand — and
// is no longer a source of access anywhere.
//
// The list is disco_restaurant_location_access for the person the VERIFIED
// token names (lib/fm-token-verify.ts), excluding archived restaurants — the
// same rows a Disco-password session resolves through getDiscoGroupAccounts.
// Before the switch, every FamilyMeal-assigned location was confirmed to be on
// this list (the 21 Oct migration was a union), so nobody lost one.
//
// Returns an empty set for anything that is not a verified FM SYSTEM_ADMIN
// token, and on any error (fail closed; callers fall back to home).
export async function getFmSessionPermittedRefs(token: string): Promise<Set<string>> {
  try {
    const claims = await verifiedFmClaims(token)
    if (!claims || (claims.role as string) !== 'SYSTEM_ADMIN') return new Set()
    const email = String(claims.sub || claims.email || '').trim().toLowerCase()
    return await discoListForEmail(email)
  } catch {
    return new Set()
  }
}

/** A person's Disco location list, archived restaurants excluded. Exported for the comparison script. */
export async function discoListForEmail(email: string): Promise<Set<string>> {
  const e = (email || '').trim().toLowerCase()
  if (!e) return new Set()
  const rows = (await sql`
    SELECT g.restaurant_reference AS ref
      FROM disco_restaurant_location_access g
     WHERE lower(g.account_email) = ${e}
       AND NOT EXISTS (SELECT 1 FROM disco_restaurant_overrides o
                        WHERE o.restaurant_reference = g.restaurant_reference AND o.archived_at IS NOT NULL)
  `) as Array<{ ref: string }>
  return new Set(rows.map(r => r.ref).filter(Boolean))
}

// Decode restaurant reference UUID.
//
// SUPER_ADMIN is unrestricted — the Disco Cater team. FM's own SUPER_ADMIN
// controller takes any restaurantReference with no per-restaurant ACL, so the
// role itself is the authorization. Unchanged.
//
// SYSTEM_ADMIN honours the selected-restaurant cookie ONLY if it is on their
// Disco list (getFmSessionPermittedRefs). Otherwise their home — the JWT's
// 'restaurant' claim — when that is on the list, else the first location on
// the list. This is the FM-session twin of resolveDiscoScopeRef and resolves to
// the same list. Plain ADMIN never trusts the cookie, same as before.
export async function getRestaurantRef(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = await decodeJwt(token)
  const role = (payload?.role as string) || ''
  const home = (payload?.restaurant as string) || null

  if (role === 'SUPER_ADMIN') {
    const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
    return selected || home
  }
  if (role !== 'SYSTEM_ADMIN') return home

  const permitted = await getFmSessionPermittedRefs(token)
  const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
  if (selected && permitted.has(selected)) return selected
  if (home && (permitted.has(home) || !permitted.size)) return home
  return permitted.values().next().value ?? home
}

// For Middleware (Edge runtime — next/headers not available)
export function getRestaurantTokenFromRequest(req: NextRequest): string | null {
  return req.cookies.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
}
