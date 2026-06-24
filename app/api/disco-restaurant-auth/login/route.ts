import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import {
  verifyPassword,
  getDiscoRestaurantAccount,
  createDiscoRestaurantSession,
  DISCO_RESTAURANT_COOKIE,
  DISCO_RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'

const INVALID = { error: 'Invalid email or password' }

// Authenticates a Disco-native restaurant account. The restaurant login page
// tries this first and falls back to FM auth for legacy restaurant users.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(INVALID, { status: 401 })
  }

  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')
  if (!email || !password) return NextResponse.json(INVALID, { status: 401 })

  try {
    await runDiscoOrderMigrations()

    const account = await getDiscoRestaurantAccount(email)
    const passwordValid = account ? await verifyPassword(password, String(account.password_hash)) : false
    console.log('[disco-login] account found:', !!account, 'password valid:', passwordValid)
    if (!account || !passwordValid) return NextResponse.json(INVALID, { status: 401 })

    const restaurantReference = String(account.restaurant_reference)
    const token = await createDiscoRestaurantSession(restaurantReference, email)

    const res = NextResponse.json({
      success: true,
      email,
      firstName: account.first_name ?? null,
      lastName: account.last_name ?? null,
      restaurantReference,
      restaurantName: account.restaurant_name ?? null,
      role: (account.role as string) ?? 'ADMIN',
      businessName: account.business_name ?? null,
    })
    res.cookies.set(DISCO_RESTAURANT_COOKIE, token, DISCO_RESTAURANT_COOKIE_OPTS)
    return res
  } catch (err) {
    console.error('[disco-restaurant-auth/login] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(INVALID, { status: 401 })
  }
}
