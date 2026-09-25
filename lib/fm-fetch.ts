// Shared wrapper for FamilyMeal (FM) API calls. Adds a default 10s timeout via
// AbortController so a slow/hung FM response can't block a serverless function up
// to its maxDuration. Throws "FM request timed out" on timeout; otherwise behaves
// exactly like fetch().
//
// ── RETRIES A SHED REQUEST ───────────────────────────────────────────────────
// FamilyMeal's nginx rate-limits the `orders` zone and returns 429 under load.
// Without a retry the caller sees a plain failed Response, and
// syncRestaurantOrders treats that as `break` — it abandons that restaurant for
// the whole run. Because the hourly cron rotates 50 of ~4,100 restaurants, the
// next attempt is about 3.4 DAYS later, so one shed request meant a live FM
// order stayed invisible to the restaurant for days. Measured on 2026-09-25:
// 161 requests shed with `excess: 250` on that zone, including the sync's own
// `/public-api/v2/restaurants/{ref}/orders` calls.
//
// Retrying here rather than in each caller keeps the rule in one place. The
// backoff is deliberately small and bounded: the point is to survive a burst,
// not to sit in a serverless function holding a slot. Retries only the statuses
// that mean "try again" — never a 4xx that would fail identically.
const RETRY_STATUSES = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 3

export async function fmFetch(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  let lastRes: Response | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) return res
      lastRes = res
      // Honour Retry-After when FM sends one; otherwise 400ms, 1200ms.
      const ra = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3_000) : attempt * 400
      await new Promise(r => setTimeout(r, waitMs))
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('FM request timed out')
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  // Unreachable in practice: the loop returns on the final attempt.
  return lastRes as Response
}
