import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_OPTS } from '../../../../lib/auth'

const FM = 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('disco_refresh')?.value
  if (!refreshToken) return NextResponse.json({ error: 'No refresh token' }, { status: 401 })

  try {
    const res = await fetch(`${FM}/refreshToken`, {
      method: 'POST',
      headers: { RefreshToken: refreshToken, Accept: 'application/json' },
    })
    const data = await res.json()
    if (!res.ok) {
      const resp = NextResponse.json({ error: 'Session expired. Please log in again.' }, { status: 401 })
      resp.cookies.delete('disco_token')
      resp.cookies.delete('disco_refresh')
      return resp
    }
    const token = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const newRefresh = String(data.refreshToken || refreshToken).trim()
    const resp = NextResponse.json({ ok: true })
    resp.cookies.set('disco_token', token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 7 })
    resp.cookies.set('disco_refresh', newRefresh, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
    return resp
  } catch {
    return NextResponse.json({ error: 'Refresh error' }, { status: 500 })
  }
}
