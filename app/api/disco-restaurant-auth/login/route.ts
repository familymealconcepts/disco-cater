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
import { matchesMasterPassword, recordMasterPasswordLogin, resolveFmMasterTarget } from '../../../../lib/master-login'

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

    // ── MASTER PASSWORD, NO DISCO ACCOUNT ROW ─────────────────────────────
    // The Disco team enters restaurants on behalf of admins and system admins.
    // Until now that only worked for an email Neon already knew: the check above
    // requires `account`, so for an FM-backed restaurant the login failed here
    // and the page fell through to FamilyMeal's /login, which accepts the master
    // password too. Two consequences, both closed here — the team's access
    // depended on a fallback that is being removed, and every master-password
    // entry into an FM-backed restaurant was completely unaudited (all 296
    // recorded logins are Disco-native; the FM-backed half never reached Disco).
    //
    // FamilyMeal remains the access authority: it is asked what this email
    // reaches and its answer is used verbatim, the same `reference` and `role`
    // the fallback consumed. No role logic, permission or ACL changes — only
    // which credential opens the session, and where the role is read from.
    if (!account && matchesMasterPassword(password)) {
      const target = await resolveFmMasterTarget(email)
      // Indistinguishable from any other failed login — never reveal whether the
      // master password was right but the email unknown to FamilyMeal.
      if (!target) return NextResponse.json(INVALID, { status: 401 })

      if (await isDiscoRestaurantArchived(target.restaurantReference)) {
        return NextResponse.json({ error: 'This restaurant is no longer active.' }, { status: 403 })
      }

      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null
      const userAgent = req.headers.get('user-agent') || null
      console.warn('[disco-login] MASTER PASSWORD used to log in (no Disco account row):', email, target.restaurantReference)
      // The one compensating control for an unrestricted bypass. It must run on
      // THIS path above all — it is the path that had no audit trail at all.
      await recordMasterPasswordLogin({
        restaurantReference: target.restaurantReference, email, ip, userAgent,
      })

      const restaurantName = target.restaurantName
      const mpToken = await createDiscoRestaurantSession(target.restaurantReference, email, {
        role: target.role, viaMasterPassword: true, restaurantName,
      })

      // Same response shape as an ordinary success — nothing observable
      // distinguishes which password was used, matching the existing override.
      const mpRes = NextResponse.json({
        success: true,
        email,
        firstName: target.firstName,
        lastName: target.lastName,
        restaurantReference: target.restaurantReference,
        restaurantName,
        role: target.role,
        businessName: restaurantName,
      })
      mpRes.cookies.set(DISCO_RESTAURANT_COOKIE, mpToken, DISCO_RESTAURANT_COOKIE_OPTS)
      return mpRes
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
