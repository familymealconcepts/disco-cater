import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { verifiedFmClaims, decodeJwtUnverified } from './fm-token-verify'

export const ADMIN_TOKEN_COOKIE = 'fm_admin_token'
export const ADMIN_REFRESH_COOKIE = 'fm_admin_refresh'

export const ADMIN_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

// ── EVERY ADMIN HELPER ANSWERS ONLY FOR A VERIFIED SUPER ADMIN (22 Oct 2026) ──
// These used to check that the cookie EXISTED (getAdminAuthHeader) or decode
// the role/email out of it without verifying the signature (getAdminRole,
// getAdminEmail). Every admin route is built on them, so a hand-made cookie
// passed all of them: Disco-only admin writes, restaurant archive and
// permanent delete (gated on the cookie's email), order edit/charge/refund via
// resolveOrderAccess. Now each one first has FamilyMeal accept the token
// (lib/fm-token-verify.ts) and requires role SUPER_ADMIN — the only role the
// admin login ever issues — so no route's allowed actions change for a real
// Super Admin, and a forged or expired cookie gets nothing.
async function verifiedAdminClaims(): Promise<{ token: string; claims: Record<string, unknown> } | null> {
  const store = await cookies()
  const token = store.get(ADMIN_TOKEN_COOKIE)?.value
  if (!token) return null
  const claims = await verifiedFmClaims(token)
  if (!claims || (claims.role as string) !== 'SUPER_ADMIN') return null
  return { token, claims }
}

export async function getAdminToken(): Promise<string | null> {
  return (await verifiedAdminClaims())?.token ?? null
}

// FM API expects raw JWT: Authorization: <token> (no Bearer prefix).
// Throws unless the caller is a verified Super Admin.
export async function getAdminAuthHeader(): Promise<Record<string, string>> {
  const v = await verifiedAdminClaims()
  if (!v) throw new Error('Not authenticated')
  return { Authorization: v.token }
}

export async function getAdminRole(): Promise<string | null> {
  return (await verifiedAdminClaims()) ? 'SUPER_ADMIN' : null
}

// The logged-in admin's email, from the VERIFIED token. FM puts the email in
// the `sub` claim (it's the login identifier); `email` is accepted as a
// fallback. Used to attribute admin actions (e.g. order transfers) and to gate
// restaurant archiving.
export async function getAdminEmail(): Promise<string | null> {
  const v = await verifiedAdminClaims()
  if (!v) return null
  return (v.claims.email as string) || (v.claims.sub as string) || null
}

/** Verified Super Admin, with the status to return when not. */
export async function verifySuperAdmin(): Promise<{ ok: true; email: string | null } | { ok: false; status: number }> {
  const store = await cookies()
  if (!store.get(ADMIN_TOKEN_COOKIE)?.value) return { ok: false, status: 401 }
  const v = await verifiedAdminClaims()
  if (!v) return { ok: false, status: 401 }
  return { ok: true, email: (v.claims.email as string) || (v.claims.sub as string) || null }
}

/**
 * For routes that receive a NextRequest (cron routes' manual trigger): true
 * only for a verified Super Admin. Replaces `!!getAdminTokenFromRequest(req)`,
 * which accepted any cookie value at all.
 */
export async function isVerifiedSuperAdminRequest(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(ADMIN_TOKEN_COOKIE)?.value
  const claims = await verifiedFmClaims(token)
  return !!claims && (claims.role as string) === 'SUPER_ADMIN'
}

// For Middleware (Edge runtime — next/headers not available)
export function getAdminTokenFromRequest(req: NextRequest): string | null {
  return req.cookies.get(ADMIN_TOKEN_COOKIE)?.value ?? null
}

export function getAdminRoleFromRequest(req: NextRequest): string | null {
  const token = getAdminTokenFromRequest(req)
  if (!token) return null
  const payload = decodeJwtUnverified(token)
  return (payload?.role as string) || null
}
