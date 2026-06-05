import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_OPTS } from '../../../../lib/auth'
import { SESSION_MAX_AGE, tokenNeedsRefresh } from '../../../../lib/jwt'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Proactive/transparent token refresh. Called on every page load (no-op when the
// access token is still fresh) and forced (`?force=1`) after a 401 from FM.
//   • token still valid for >24h and not forced → no-op, no FM round-trip
//   • token expiring/expired (or forced) → POST FM /refreshToken, rotate cookies
//   • no refresh token, or FM rejects it → clear cookies + 401 (client → login)
export async function POST(req: NextRequest) {
  const token = req.cookies.get('disco_token')?.value
  const refreshToken = req.cookies.get('disco_refresh')?.value
  const force = req.nextUrl.searchParams.get('force') === '1'

  // Nothing to do for a logged-out visitor.
  if (!token && !refreshToken) return NextResponse.json({ ok: true, refreshed: false })

  // Still fresh — skip the FM call (unless the caller forces, e.g. after a 401).
  if (token && !force && !tokenNeedsRefresh(token)) {
    return NextResponse.json({ ok: true, refreshed: false })
  }

  if (!refreshToken) {
    const resp = NextResponse.json({ error: 'Session expired. Please log in again.' }, { status: 401 })
    resp.cookies.delete('disco_token')
    resp.cookies.delete('disco_refresh')
    return resp
  }

  try {
    const res = await fetch(`${FM}/refreshToken`, {
      method: 'POST',
      headers: { RefreshToken: refreshToken, Accept: 'application/json' },
    })
    if (!res.ok) {
      const resp = NextResponse.json({ error: 'Session expired. Please log in again.' }, { status: 401 })
      resp.cookies.delete('disco_token')
      resp.cookies.delete('disco_refresh')
      return resp
    }
    const data = await res.json()
    const newToken = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const newRefresh = String(data.refreshToken || refreshToken).trim()
    if (!newToken) return NextResponse.json({ error: 'Refresh response missing token' }, { status: 502 })
    const resp = NextResponse.json({ ok: true, refreshed: true })
    resp.cookies.set('disco_token', newToken, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
    resp.cookies.set('disco_refresh', newRefresh, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
    return resp
  } catch {
    return NextResponse.json({ error: 'Refresh error' }, { status: 500 })
  }
}
