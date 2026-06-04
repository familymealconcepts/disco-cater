import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_OPTS } from '../../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Customer sign-up. Proxies to FM /registration, sets the diner session cookies
// (same as /api/fm-auth login so /account/* is authenticated), and returns the
// user payload for the client to persist as `currentUser`.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { email, firstName, lastName, password, phoneNumber } = body
    if (!email || !password || !firstName || !lastName) {
      return NextResponse.json({ error: 'First name, last name, email and password are required.' }, { status: 400 })
    }

    const fmRes = await fetch(`${FM}/registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, firstName, lastName, password, phoneNumber: phoneNumber || '' }),
    })
    const data = await fmRes.json().catch(() => null)
    if (!fmRes.ok) {
      return NextResponse.json({ error: data?.message || data?.description || 'Sign up failed.' }, { status: fmRes.status })
    }

    const authorization = String(data?.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const refreshToken = String(data?.refreshToken || '').trim()

    const resp = NextResponse.json({
      authorization,
      refreshToken,
      email: data?.email || email,
      firstName: data?.firstName || firstName,
      lastName: data?.lastName || lastName,
      phoneNumber: data?.phoneNumber || phoneNumber || '',
      reference: data?.reference || '',
      role: data?.role || '',
    })
    if (authorization) {
      resp.cookies.set('disco_token', authorization, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 7 })
      resp.cookies.set('disco_refresh', refreshToken, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
    }
    return resp
  } catch {
    return NextResponse.json({ error: 'Unable to connect. Please try again.' }, { status: 500 })
  }
}
