import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'

export const ADMIN_TOKEN_COOKIE = 'fm_admin_token'
export const ADMIN_REFRESH_COOKIE = 'fm_admin_refresh'

export const ADMIN_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

export async function getAdminToken(): Promise<string | null> {
  const store = await cookies()
  return store.get(ADMIN_TOKEN_COOKIE)?.value ?? null
}

// FM API expects raw JWT: Authorization: <token> (no Bearer prefix)
export async function getAdminAuthHeader(): Promise<Record<string, string>> {
  const store = await cookies()
  const token = store.get(ADMIN_TOKEN_COOKIE)?.value
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

export async function getAdminRole(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(ADMIN_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  return (payload?.role as string) || null
}

// The logged-in admin's email, decoded from the fm_admin_token JWT. FM puts the
// email in the `sub` claim (it's the login identifier); `email` is accepted as a
// fallback. Used to attribute admin actions (e.g. order transfers).
export async function getAdminEmail(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(ADMIN_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  return (payload?.email as string) || (payload?.sub as string) || null
}

// ── A VERIFIED SUPER ADMIN, FOR ROUTES THAT WRITE TO DISCO ──────────────────
// getAdminAuthHeader only checks that the cookie EXISTS, and getAdminRole reads
// the role out of the token WITHOUT verifying its signature. That was enough
// for routes that proxy to FamilyMeal (FM rejects a bad token itself), but a
// route that writes only to Disco would accept any hand-made cookie claiming
// SUPER_ADMIN. This asks FamilyMeal to accept the token (a read of the caller's
// own profile) before the decoded role is trusted. Cached briefly per token so
// a page of actions costs one round trip.
const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const verifiedTokens = new Map<string, number>()
const VERIFY_TTL_MS = 5 * 60 * 1000

export async function verifySuperAdmin(): Promise<{ ok: true; email: string | null } | { ok: false; status: number }> {
  const token = await getAdminToken()
  if (!token) return { ok: false, status: 401 }
  const payload = decodeJwt(token)
  if ((payload?.role as string) !== 'SUPER_ADMIN') return { ok: false, status: 403 }
  const email = (payload?.email as string) || (payload?.sub as string) || null
  const until = verifiedTokens.get(token)
  if (until && until > Date.now()) return { ok: true, email }
  try {
    const res = await fetch(`${FM_BASE}/api/users`, { headers: { Authorization: token }, cache: 'no-store' })
    if (!res.ok) return { ok: false, status: 401 }
    const me = await res.json().catch(() => null) as { role?: string } | null
    if (me?.role && me.role !== 'SUPER_ADMIN') return { ok: false, status: 403 }
  } catch {
    return { ok: false, status: 503 } // fail closed
  }
  verifiedTokens.set(token, Date.now() + VERIFY_TTL_MS)
  if (verifiedTokens.size > 500) verifiedTokens.clear()
  return { ok: true, email }
}

// For Middleware (Edge runtime — next/headers not available)
export function getAdminTokenFromRequest(req: NextRequest): string | null {
  return req.cookies.get(ADMIN_TOKEN_COOKIE)?.value ?? null
}

export function getAdminRoleFromRequest(req: NextRequest): string | null {
  const token = getAdminTokenFromRequest(req)
  if (!token) return null
  const payload = decodeJwt(token)
  return (payload?.role as string) || null
}
