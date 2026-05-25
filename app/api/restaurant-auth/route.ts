import { NextRequest, NextResponse } from 'next/server'
import { RESTAURANT_COOKIE_OPTS, RESTAURANT_TOKEN_COOKIE, RESTAURANT_REFRESH_COOKIE } from '../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
    }

    const fmRes = await fetch(`${FM}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    const data = await fmRes.json()
    console.log('FM auth response:', JSON.stringify(data))
    if (!fmRes.ok) {
      return NextResponse.json({ error: data.message || 'Authentication failed.' }, { status: 401 })
    }

    const role = data.role || ''
    if (role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'This account does not have restaurant access.' },
        { status: 403 }
      )
    }

    const rawToken = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const refreshToken = String(data.refreshToken || '').trim()

    const userPayload = {
      email: data.email || email,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      role: data.role,
      reference: data.reference || '',
    }

    const resp = NextResponse.json(userPayload)
    if (rawToken) {
      resp.cookies.set(RESTAURANT_TOKEN_COOKIE, rawToken, {
        ...RESTAURANT_COOKIE_OPTS,
        maxAge: 60 * 60 * 24 * 7,
      })
    }
    if (refreshToken) {
      resp.cookies.set(RESTAURANT_REFRESH_COOKIE, refreshToken, {
        ...RESTAURANT_COOKIE_OPTS,
        maxAge: 60 * 60 * 24 * 30,
      })
    }
    return resp
  } catch (err) {
    console.error('restaurant-auth error:', err)
    return NextResponse.json({ error: 'Unable to connect. Please try again.' }, { status: 500 })
  }
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete(RESTAURANT_TOKEN_COOKIE)
  resp.cookies.delete(RESTAURANT_REFRESH_COOKIE)
  return resp
}
