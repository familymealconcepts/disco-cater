import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_OPTS } from '../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function setAuthCookies(resp: NextResponse, token: string, refreshToken: string) {
  resp.cookies.set('disco_token', token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 7 })
  resp.cookies.set('disco_refresh', refreshToken, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
}

// Login or Register
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { action = 'login', email, password, firstName, lastName, phoneNumber } = body

    let fmRes: Response
    if (action === 'register') {
      if (!email || !password || !firstName || !lastName) {
        return NextResponse.json({ error: 'First name, last name, email and password are required.' }, { status: 400 })
      }
      fmRes = await fetch(`${FM}/registration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password, firstName, lastName, phoneNumber: phoneNumber || '' }),
      })
    } else {
      if (!email || !password) return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
      fmRes = await fetch(`${FM}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    }

    const data = await fmRes.json()
    if (!fmRes.ok) return NextResponse.json({ error: data.message || 'Authentication failed.' }, { status: 401 })

    const rawToken = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const refreshToken = String(data.refreshToken || '').trim()

    const userPayload = {
      email: data.email || email,
      firstName: data.firstName || firstName || '',
      lastName: data.lastName || lastName || '',
      phoneNumber: data.phoneNumber || phoneNumber || '',
      reference: data.reference || '',
      role: data.role,
    }

    const resp = NextResponse.json(userPayload)
    if (rawToken) setAuthCookies(resp, rawToken, refreshToken)
    return resp
  } catch (err) {
    console.error('fm-auth error:', err)
    return NextResponse.json({ error: 'Unable to connect. Please try again.' }, { status: 500 })
  }
}

// Logout — clears httpOnly cookies
export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete('disco_token')
  resp.cookies.delete('disco_refresh')
  return resp
}
