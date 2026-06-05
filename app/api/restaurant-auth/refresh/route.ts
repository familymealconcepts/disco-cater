import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  RESTAURANT_TOKEN_COOKIE,
  RESTAURANT_REFRESH_COOKIE,
  RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/restaurant-auth'
import { SESSION_MAX_AGE, tokenNeedsRefresh } from '../../../../lib/jwt'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Proactive/transparent restaurant token refresh — called on every restaurant
// portal page load. Previously the restaurant portal had NO refresh route at
// all, so users were silently logged out once the access token expired.
// No-op when fresh; rotates cookies when expiring/expired; clears cookies + 401
// when the refresh token is gone or FM rejects it.
export async function POST() {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  const refresh = store.get(RESTAURANT_REFRESH_COOKIE)?.value

  if (!token && !refresh) return NextResponse.json({ ok: true, refreshed: false })

  if (token && !tokenNeedsRefresh(token)) {
    return NextResponse.json({ ok: true, refreshed: false })
  }

  if (!refresh) {
    const resp = NextResponse.json({ error: 'Session expired' }, { status: 401 })
    resp.cookies.delete(RESTAURANT_TOKEN_COOKIE)
    resp.cookies.delete(RESTAURANT_REFRESH_COOKIE)
    return resp
  }

  try {
    const res = await fetch(`${FM}/refreshToken`, {
      method: 'POST',
      headers: { RefreshToken: refresh, Accept: 'application/json' },
    })
    if (!res.ok) {
      const resp = NextResponse.json({ error: 'Refresh failed' }, { status: 401 })
      resp.cookies.delete(RESTAURANT_TOKEN_COOKIE)
      resp.cookies.delete(RESTAURANT_REFRESH_COOKIE)
      return resp
    }
    const data = await res.json()
    const newToken = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const newRefresh = String(data.refreshToken || refresh).trim()
    if (!newToken) return NextResponse.json({ error: 'Refresh response missing token' }, { status: 502 })
    const resp = NextResponse.json({ ok: true, refreshed: true })
    resp.cookies.set(RESTAURANT_TOKEN_COOKIE, newToken, { ...RESTAURANT_COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
    resp.cookies.set(RESTAURANT_REFRESH_COOKIE, newRefresh, { ...RESTAURANT_COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
    return resp
  } catch {
    return NextResponse.json({ error: 'Unable to refresh' }, { status: 500 })
  }
}
