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

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

let cachedToken: string | null = null
let cachedExpMs = 0

function decodeExpMs(token: string): number {
  try {
    const json = Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    const payload = JSON.parse(json)
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

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
  })
  if (!res.ok) throw new Error(`FM service login failed: ${res.status}`)
  const data = await res.json().catch(() => null)
  // FM /login returns { authorization, refreshToken, ... }. The authorization
  // value may carry a "Bearer " prefix; FM's own API expects the raw JWT, so
  // strip it (mirrors the sync-restaurants cron's fmLogin()).
  const token = String(data?.authorization || data?.token || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error('FM service login returned no token')
  return token
}

/** Returns a valid service JWT, logging in (or re-logging in) as needed. */
export async function getFmServiceToken(forceRefresh = false): Promise<string> {
  const now = Date.now()
  if (!forceRefresh && cachedToken && now < cachedExpMs - 60_000) return cachedToken
  const token = await login()
  cachedToken = token
  const exp = decodeExpMs(token)
  cachedExpMs = exp > 0 ? exp : now + 30 * 60_000 // fallback 30 min if no exp claim
  return token
}

/** FM expects the raw JWT in Authorization (no "Bearer " prefix). */
export async function getFmServiceAuthHeader(forceRefresh = false): Promise<Record<string, string>> {
  return { Authorization: await getFmServiceToken(forceRefresh) }
}
