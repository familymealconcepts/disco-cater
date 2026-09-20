// Rate-bounding for FM /login calls.
//
// Extracted 2026-09-20 after the FM login-storm outage. FM's backend froze under
// ~20 POST /login per second (UA "node"); the fault on FM's side was HikariCP
// pool exhaustion (maximumPoolSize=15, connectionTimeout=120s), but Disco was the
// amplifier: its service token was cached ONLY on success, so once FM started
// failing nothing was ever cached and every request that touched FM became a
// fresh login. FM's 500s drove MORE logins, not fewer.
//
// The invariant every caller of this module gets:
//
//     FM returning errors must never cause Disco to increase its login rate.
//
// Four mechanisms, each closing a different door:
//   1. single-flight   — N concurrent cold-cache callers share ONE login
//   2. circuit breaker — after a failure, refuse to call FM until a cooldown ends
//   3. backoff+jitter  — cooldown doubles 1s→60s, so the rate FALLS as failures mount
//   4. fetch timeout   — a hung FM can't pin a lambda for 120s and stack requests
//
// This lives in its own file so the service account (lib/fm-service-auth.ts) and
// the master-admin identities (lib/fm-master-admin-read.ts) share ONE
// implementation. They must NOT share a token cache — different credentials, and
// master-admin tokens are per-email — so the guard is instantiated per identity
// and holds only that identity's state.
//
// LIMITATION: state is module-level, so a guard bounds EACH LAMBDA INSTANCE, not
// the fleet. Fleet-wide bounding would need shared state (Neon/Redis). Deliberate
// for now — this still converts "every request is a login" into "at most one login
// per instance per cooldown", which is what stops the amplification.

/** A hung FM must not hold a lambda open behind it. FM's own connectionTimeout
 *  is 120s; give up well before that so requests drain instead of stacking. */
export const FM_LOGIN_TIMEOUT_MS = 10_000
const BASE_COOLDOWN_MS = 1_000
const MAX_COOLDOWN_MS = 60_000
/** Re-login this long before the JWT's own expiry. */
const EXPIRY_MARGIN_MS = 60_000
/** Used when a token carries no `exp` claim. */
const FALLBACK_TTL_MS = 30 * 60_000

export interface LoginGuardState {
  hasToken: boolean
  expiresInMs: number
  consecutiveFailures: number
  cooldownRemainingMs: number
  lastFailure: string | null
}

export interface LoginGuard {
  /** Returns a valid JWT, calling `login` only when the cache is cold or stale
   *  AND the breaker is closed. Throws without touching FM while it is open. */
  get(login: () => Promise<string>, forceRefresh?: boolean): Promise<string>
  state(): LoginGuardState
}

/** Milliseconds until a JWT's `exp`, or 0 if it has none / can't be parsed. */
export function decodeJwtExpMs(token: string): number {
  try {
    const json = Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    const payload = JSON.parse(json)
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

/** Cooldown after `n` consecutive failures: 1s, 2s, 4s … capped at 60s, plus
 *  jitter so many lambda instances don't retry in lockstep. */
function cooldownFor(n: number): number {
  const base = Math.min(BASE_COOLDOWN_MS * 2 ** Math.max(0, n - 1), MAX_COOLDOWN_MS)
  return base + Math.floor(Math.random() * Math.min(base, 1_000))
}

/**
 * One guard per identity. `label` only appears in error messages.
 */
export function createLoginGuard(label: string): LoginGuard {
  let cachedToken: string | null = null
  let cachedExpMs = 0

  let consecutiveFailures = 0
  let cooldownUntilMs = 0
  let lastFailure: string | null = null

  // Concurrent callers await this one promise instead of each issuing a login.
  let inFlight: Promise<string> | null = null

  return {
    async get(login: () => Promise<string>, forceRefresh = false): Promise<string> {
      const now = Date.now()
      if (!forceRefresh && cachedToken && now < cachedExpMs - EXPIRY_MARGIN_MS) return cachedToken

      // Breaker open — do not touch FM.
      if (now < cooldownUntilMs) {
        // A token we still hold and that has not actually expired beats failing:
        // serving it costs FM nothing and keeps the caller working.
        if (cachedToken && now < cachedExpMs) return cachedToken
        const waitS = Math.ceil((cooldownUntilMs - now) / 1000)
        throw new Error(
          `FM login (${label}) suppressed for ${waitS}s after ${consecutiveFailures} consecutive failures (last: ${lastFailure})`,
        )
      }

      // Single-flight: join the login already in progress rather than starting another.
      if (inFlight) return inFlight

      inFlight = (async () => {
        try {
          const token = await login()
          cachedToken = token
          const exp = decodeJwtExpMs(token)
          cachedExpMs = exp > 0 ? exp : Date.now() + FALLBACK_TTL_MS
          consecutiveFailures = 0
          cooldownUntilMs = 0
          lastFailure = null
          return token
        } catch (e) {
          consecutiveFailures++
          lastFailure = e instanceof Error ? e.message : String(e)
          cooldownUntilMs = Date.now() + cooldownFor(consecutiveFailures)
          throw e
        } finally {
          inFlight = null
        }
      })()

      return inFlight
    },

    state(): LoginGuardState {
      const now = Date.now()
      return {
        hasToken: !!cachedToken,
        expiresInMs: cachedToken ? Math.max(0, cachedExpMs - now) : 0,
        consecutiveFailures,
        cooldownRemainingMs: Math.max(0, cooldownUntilMs - now),
        lastFailure,
      }
    },
  }
}
