'use client'

// Wraps fetch() for restaurant-portal screens that call FM-proxy API routes
// (app/api/restaurant/*) under the fm_restaurant_token cookie.
//
// Why this exists: the portal layout's refresh-on-mount check
// (app/(restaurant)/restaurant/(portal)/layout.tsx) only runs once per hard
// page load. A tab left open longer than the underlying FM JWT's real
// lifetime (hours-scale) carries an expired token into every subsequent
// fetch with nothing to catch it -- and the FM-proxy routes correctly return
// 401, but callers that only checked `res.ok` treated that identically to
// "fetched, got zero rows" (the "No items in this category" bug, confirmed
// 2026-08-01). This wraps the retry/redirect logic once so every caller gets
// a real distinction between "auth expired" and "genuinely empty".
//
// On a 401: attempt the same silent refresh the portal layout calls on
// mount; if that succeeds, retry the original request once (transparent to
// the caller -- they just see a fresh Response). If refresh itself fails
// (refresh token also gone/invalid), hard-navigate to login rather than let
// the caller render a false empty state.
export async function fetchWithAuthRetry(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status !== 401) return res

  try {
    const refreshRes = await fetch('/api/restaurant-auth/refresh', { method: 'POST' })
    if (refreshRes.ok) {
      const refreshData = (await refreshRes.json().catch(() => null)) as { ok?: boolean } | null
      if (refreshData?.ok) return fetch(input, init) // retry once with the rotated cookie
    }
  } catch { /* fall through to redirect */ }

  try { localStorage.removeItem('restaurant_user') } catch {}
  if (typeof window !== 'undefined') window.location.href = '/restaurant/login'
  return res
}
