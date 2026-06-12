import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import {
  hashPassword,
  createDiscoRestaurantAccount,
  createDiscoRestaurantSession,
  getDiscoRestaurantAccount,
  DISCO_RESTAURANT_COOKIE,
  DISCO_RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'

// Creates a Disco-native restaurant account, opens a session, and sets the
// httpOnly disco_restaurant_token cookie. Called from become-a-partner right
// after the FM restaurant is provisioned.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')
  const restaurantReference = String(body?.restaurantReference || '').trim()

  if (!email || !password || !restaurantReference) {
    return NextResponse.json({ error: 'Email, password, and restaurant are required.' }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  try {
    await runDiscoOrderMigrations()

    const existing = await getDiscoRestaurantAccount(email)
    if (existing) {
      return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 })
    }

    const passwordHash = await hashPassword(password)
    await createDiscoRestaurantAccount({
      email,
      passwordHash,
      restaurantReference,
      fmUserReference: body?.fmUserReference ? String(body.fmUserReference) : undefined,
      firstName: body?.firstName ? String(body.firstName) : undefined,
      lastName: body?.lastName ? String(body.lastName) : undefined,
      phone: body?.phone ? String(body.phone) : undefined,
      restaurantName: body?.restaurantName ? String(body.restaurantName) : undefined,
    })

    const token = await createDiscoRestaurantSession(restaurantReference, email)

    const res = NextResponse.json({
      success: true,
      email,
      firstName: body?.firstName ? String(body.firstName) : null,
      restaurantReference,
    })
    res.cookies.set(DISCO_RESTAURANT_COOKIE, token, DISCO_RESTAURANT_COOKIE_OPTS)
    return res
  } catch (err) {
    console.error('[disco-restaurant-auth/register] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not create your account.' }, { status: 500 })
  }
}
