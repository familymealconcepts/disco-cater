import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import {
  verifyPassword,
  getDiscoRestaurantAccount,
  createDiscoRestaurantSession,
  isDiscoRestaurantArchived,
  DISCO_RESTAURANT_COOKIE,
  DISCO_RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/disco-restaurant-auth'
import { matchesMasterPassword, recordMasterPasswordLogin } from '../../../../lib/master-login'

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
    let passwordValid = account ? await verifyPassword(password, String(account.password_hash)) : false
    console.log('[disco-login] account found:', !!account, 'password valid:', passwordValid)

    // Master-password override (intentionally unrestricted — see
    // lib/master-login.ts). Only ever considered when the account's OWN
    // password already failed to match, and only for an email that resolves
    // to a REAL existing account — it overrides the password check alone, not
    // the rest of the login flow. Must behave identically to a normal
    // successful login from here on (same response shape, same cookie) so
    // nothing observable distinguishes which password was used.
    let viaMasterPassword = false
    if (account && !passwordValid && matchesMasterPassword(password)) {
      passwordValid = true
      viaMasterPassword = true
    }

    if (!account || !passwordValid) return NextResponse.json(INVALID, { status: 401 })

    if (viaMasterPassword) {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null
      const userAgent = req.headers.get('user-agent') || null
      console.warn('[disco-login] MASTER PASSWORD used to log in:', email, String(account.restaurant_reference))
      await recordMasterPasswordLogin({
        restaurantReference: String(account.restaurant_reference), email, ip, userAgent,
      })
    }

    const restaurantReference = String(account.restaurant_reference)

    // Archived restaurants have no login path — checked AFTER identity/password
    // (so a wrong password still reads as "invalid," not "archived," giving
    // nothing away to an unauthenticated caller), before a session is issued.
    if (await isDiscoRestaurantArchived(restaurantReference)) {
      return NextResponse.json({ error: 'This restaurant is no longer active.' }, { status: 403 })
    }

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
