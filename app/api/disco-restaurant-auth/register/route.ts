import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations, sql } from '../../../../lib/db'
import {
  hashPassword,
  verifyPassword,
  createDiscoRestaurantAccount,
  createDiscoRestaurantSession,
  getDiscoRestaurantAccount,
  hasValidDiscoRestaurantSession,
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

  console.log('[disco-register] starting for:', email)

  if (!email || !password || !restaurantReference) {
    return NextResponse.json({ error: 'Email, password, and restaurant are required.' }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  // GUARD: never silently relabel an existing FM-backed restaurant as Disco-native.
  // A Disco-native account here defaults is_disco_native=true. If this reference
  // already belongs to a real restaurant — it has FamilyMeal order history, or an
  // existing account already linked to FM — registering on it would corrupt that
  // restaurant's classification (exactly how Test Kitchen / c8322ff4 was lost).
  // New onboarding always uses a fresh reference with neither, so this never blocks
  // legitimate signups. Best-effort: a check failure must not block real onboarding.
  try {
    const fmHistory = (await sql`SELECT 1 FROM fm_historical_orders WHERE restaurant_reference::text = ${restaurantReference} LIMIT 1`) as unknown[]
    const fmBacked = (await sql`
      SELECT 1 FROM disco_restaurant_accounts
      WHERE restaurant_reference = ${restaurantReference}
        AND (fm_restaurant_reference IS NOT NULL OR is_disco_native = false)
      LIMIT 1`) as unknown[]
    if (fmHistory.length || fmBacked.length) {
      console.warn('[disco-register] BLOCKED: reference belongs to an FM-backed restaurant:', restaurantReference, '(email:', email + ')')
      return NextResponse.json(
        { error: 'This restaurant is already registered with FamilyMeal and cannot be re-registered as a Disco-native restaurant.' },
        { status: 409 },
      )
    }
  } catch (guardErr) {
    console.error('[disco-register] FM-ownership guard check failed (allowing signup):', guardErr instanceof Error ? guardErr.message : guardErr)
  }

  // Migrations are best-effort — a failure here must NOT block the insert (the
  // tables almost certainly already exist).
  try {
    await runDiscoOrderMigrations()
  } catch (migrationError) {
    console.error('[disco-register] migration warning (non-fatal):', migrationError)
    // Continue — tables likely already exist
  }

  try {
    const existing = await getDiscoRestaurantAccount(email)
    if (existing) {
      // The account already exists — possibly a partial state from a prior
      // attempt that created the account but never issued a session. Self-heal by
      // issuing a fresh session, but ONLY for the legitimate owner: verify the
      // password first, or this becomes an account-takeover vector.
      const ownerOk = await verifyPassword(password, String(existing.password_hash || ''))
      if (!ownerOk) {
        return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 })
      }
      const hadSession = await hasValidDiscoRestaurantSession(email)
      console.log('[disco-register] existing account for:', email, '— valid session present:', hadSession)
      const token = await createDiscoRestaurantSession(String(existing.restaurant_reference), email)
      const res = NextResponse.json({
        success: true,
        email,
        firstName: existing.first_name ? String(existing.first_name) : null,
        restaurantName: existing.restaurant_name ? String(existing.restaurant_name) : null,
        restaurantReference: String(existing.restaurant_reference),
      })
      res.cookies.set(DISCO_RESTAURANT_COOKIE, token, DISCO_RESTAURANT_COOKIE_OPTS)
      res.cookies.delete('fm_restaurant_token')
      res.cookies.delete('fm_restaurant_refresh')
      console.log('[disco-register] success (revived existing) for:', email)
      return res
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

    // The account row now exists. If session creation fails here, the account is
    // recoverable on retry (the existing-account branch above self-heals), so we
    // return a useful error rather than the generic 500.
    let token: string
    try {
      token = await createDiscoRestaurantSession(restaurantReference, email)
    } catch (sessErr) {
      console.error('[disco-register] session creation failed after account insert:', sessErr instanceof Error ? sessErr.message : sessErr)
      return NextResponse.json({ error: 'Your account was created but the session could not be started. Please log in.' }, { status: 500 })
    }

    const res = NextResponse.json({
      success: true,
      email,
      firstName: body?.firstName ? String(body.firstName) : null,
      restaurantName: body?.restaurantName ? String(body.restaurantName) : null,
      restaurantReference,
    })
    res.cookies.set(DISCO_RESTAURANT_COOKIE, token, DISCO_RESTAURANT_COOKIE_OPTS)
    // Clear any stale FM restaurant session so the portal can't resolve the new
    // partner to a previously logged-in FM restaurant.
    res.cookies.delete('fm_restaurant_token')
    res.cookies.delete('fm_restaurant_refresh')
    console.log('[disco-register] success for:', email)
    return res
  } catch (err) {
    console.error('[disco-register] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not create your account.' }, { status: 500 })
  }
}
