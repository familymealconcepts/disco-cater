// Shared JWT read helpers. We do NOT verify signatures — FM signs and verifies
// the tokens; here we only read claims (exp) to decide when to proactively
// refresh. Never trust these claims for authorization.

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

// True when the access token is missing, undecodable, has no exp, is already
// expired, or expires within `withinSec` (default 24h). Drives the proactive
// refresh-on-load: a still-fresh token returns false so we skip the FM round-trip.
export function tokenNeedsRefresh(token: string | undefined | null, withinSec = 60 * 60 * 24): boolean {
  if (!token) return true
  const p = decodeJwtPayload(token)
  const exp = typeof p?.exp === 'number' ? p.exp : null
  if (exp == null) return true
  const nowSec = Math.floor(Date.now() / 1000)
  return exp - nowSec <= withinSec
}

// Persistent session length: access + refresh cookies both live 30 days, so a
// returning user stays logged in for 30 days as long as they visit within that
// window (each visit silently rotates the tokens forward).
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30
