// Server-side FM service-account auth.
//
// Unlike lib/admin-auth (which reads the logged-in admin's session cookie), this
// logs into FM with a dedicated service account stored in server env vars, so
// PUBLIC routes (e.g. /api/restaurants for the fullmap) can call FM's admin API
// without a per-request user session.
//
// REQUIRED ENV (set in Vercel → Project → Environment Variables):
//   FM_ADMIN_EMAIL     service-account login (a SYSTEM_ADMIN / SUPER_ADMIN user)
//   FM_ADMIN_PASSWORD  its password
//
// The JWT is cached in-module per lambda and reused until ~1 min before expiry.
//
// Rate-bounding (single-flight, circuit breaker, backoff, timeout) lives in
// lib/fm-login-guard.ts — see that file for why it exists. Short version: this
// helper sits on a per-request path, and before 2026-09-20 it cached ONLY on
// success, so an FM outage turned every Disco request into a fresh /login and
// helped freeze FM's backend. The guard makes FM errors reduce Disco's login
// rate instead of raising it.

import { createLoginGuard, FM_LOGIN_TIMEOUT_MS } from './fm-login-guard'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const guard = createLoginGuard('service account')

async function login(): Promise<string> {
  const email = process.env.FM_ADMIN_EMAIL
  const password = process.env.FM_ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error('FM service account not configured (FM_ADMIN_EMAIL / FM_ADMIN_PASSWORD)')
  }
  const res = await fetch(`${FM}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
    signal: AbortSignal.timeout(FM_LOGIN_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`FM service login failed: ${res.status}`)
  const data = await res.json().catch(() => null)
  // FM /login returns { authorization, refreshToken, ... }. The authorization
  // value may carry a "Bearer " prefix; FM's own API expects the raw JWT, so
  // strip it (mirrors the sync-restaurants cron, which now calls this helper).
  const token = String(data?.authorization || data?.token || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error('FM service login returned no token')
  return token
}

/** Returns a valid service JWT, logging in (or re-logging in) as needed.
 *
 *  Throws without calling FM while the breaker is open. Callers that already
 *  tolerate an FM failure (most catch and fall back to Neon) see the same error
 *  shape as before — just instantly instead of after a hang, and without adding
 *  load to an already-failing FM. */
export async function getFmServiceToken(forceRefresh = false): Promise<string> {
  return guard.get(login, forceRefresh)
}

/** FM expects the raw JWT in Authorization (no "Bearer " prefix). */
export async function getFmServiceAuthHeader(forceRefresh = false): Promise<Record<string, string>> {
  return { Authorization: await getFmServiceToken(forceRefresh) }
}

/** Observability for health/debug routes — never throws, never calls FM. */
export function fmServiceAuthState() {
  return guard.state()
}
