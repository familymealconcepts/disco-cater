import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  ADMIN_TOKEN_COOKIE,
  ADMIN_REFRESH_COOKIE,
  ADMIN_COOKIE_OPTS,
} from '../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST() {
  const store = await cookies()
  const refresh = store.get(ADMIN_REFRESH_COOKIE)?.value
  if (!refresh) return NextResponse.json({ error: 'No refresh token' }, { status: 401 })
  try {
    const res = await fetch(`${FM}/refreshToken`, {
      method: 'POST',
      headers: { RefreshToken: refresh, Accept: 'application/json' },
    })
    if (!res.ok) return NextResponse.json({ error: 'Refresh failed' }, { status: 401 })
    const data = await res.json()
    const token = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const newRefresh = String(data.refreshToken || '').trim()
    if (!token) return NextResponse.json({ error: 'Refresh response missing token' }, { status: 502 })
    const resp = NextResponse.json({ ok: true })
    resp.cookies.set(ADMIN_TOKEN_COOKIE, token, { ...ADMIN_COOKIE_OPTS, maxAge: 60 * 60 * 24 * 7 })
    if (newRefresh) {
      resp.cookies.set(ADMIN_REFRESH_COOKIE, newRefresh, { ...ADMIN_COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
    }
    return resp
  } catch {
    return NextResponse.json({ error: 'Unable to refresh' }, { status: 500 })
  }
}
