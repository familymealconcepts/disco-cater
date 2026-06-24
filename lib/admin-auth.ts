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
