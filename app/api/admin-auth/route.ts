import { NextRequest, NextResponse } from 'next/server'
import {
  ADMIN_TOKEN_COOKIE,
  ADMIN_REFRESH_COOKIE,
  ADMIN_COOKIE_OPTS,
} from '../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
    }
    const res = await fetch(`${FM}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }
    const data = await res.json()
    if (data.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'This portal is for FamilyMeal admins only.' }, { status: 403 })
    }
    // FM stores tokens with possible "Bearer" prefix in the response; strip if present.
    const rawToken = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const rawRefresh = String(data.refreshToken || '').trim()
    if (!rawToken) {
      return NextResponse.json({ error: 'Login response missing token' }, { status: 502 })
    }
    const resp = NextResponse.json({
      ok: true,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      role: data.role,
      reference: data.reference,
    })
    resp.cookies.set(ADMIN_TOKEN_COOKIE, rawToken, { ...ADMIN_COOKIE_OPTS, maxAge: 60 * 60 * 24 * 7 })
    if (rawRefresh) {
      resp.cookies.set(ADMIN_REFRESH_COOKIE, rawRefresh, { ...ADMIN_COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
    }
    return resp
  } catch {
    return NextResponse.json({ error: 'Unable to log in' }, { status: 500 })
  }
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete(ADMIN_TOKEN_COOKIE)
  resp.cookies.delete(ADMIN_REFRESH_COOKIE)
  return resp
}
