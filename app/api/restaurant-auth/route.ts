import { NextRequest, NextResponse } from 'next/server'
import { RESTAURANT_COOKIE_OPTS, RESTAURANT_TOKEN_COOKIE, RESTAURANT_REFRESH_COOKIE } from '../../../lib/restaurant-auth'
import { SESSION_MAX_AGE } from '../../../lib/jwt'
import { fmFetch } from '../../../lib/fm-fetch'
import { isDiscoRestaurantArchived } from '../../../lib/disco-restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
    }

    const fmRes = await fmFetch(`${FM}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    const data = await fmRes.json()
    if (!fmRes.ok) {
      return NextResponse.json({ error: data.message || 'Authentication failed.' }, { status: 401 })
    }

    const RESTAURANT_ROLES = [
      'ADMIN',
      'RESTAURANT_ADMIN',
      'RESTAURANT_USER',
      'SYSTEM_ADMIN',
      'SUPER_ADMIN',
    ]

    const role: string = data.role || ''
    if (!RESTAURANT_ROLES.includes(role)) {
      return NextResponse.json(
        { error: 'This account does not have restaurant access.' },
        { status: 403 }
      )
    }

    // This route authenticates via FM's own /login, so it's normally reached
    // only by FM-backed accounts (never archived — archive is Disco-native
    // only). It's still checked here because a restaurant that CONVERTED to
    // native can retain working legacy FM credentials whose data.reference
    // now resolves to a Disco-native, possibly-archived restaurant — a no-op
    // for genuinely FM-only accounts, real protection for that transitional
    // case.
    if (data.reference && await isDiscoRestaurantArchived(String(data.reference))) {
      return NextResponse.json({ error: 'This restaurant is no longer active.' }, { status: 403 })
    }

    const rawToken = String(data.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const refreshToken = String(data.refreshToken || '').trim()

    const userPayload = {
      email: data.email || email,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      role,
      reference: data.reference || '',
    }

    const resp = NextResponse.json(userPayload)
    if (rawToken) {
      resp.cookies.set(RESTAURANT_TOKEN_COOKIE, rawToken, {
        ...RESTAURANT_COOKIE_OPTS,
        maxAge: SESSION_MAX_AGE,
      })
    }
    if (refreshToken) {
      resp.cookies.set(RESTAURANT_REFRESH_COOKIE, refreshToken, {
        ...RESTAURANT_COOKIE_OPTS,
        maxAge: SESSION_MAX_AGE,
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
