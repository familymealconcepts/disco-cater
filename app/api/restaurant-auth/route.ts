import { NextRequest, NextResponse } from 'next/server'
import { RESTAURANT_COOKIE_OPTS, RESTAURANT_TOKEN_COOKIE, RESTAURANT_REFRESH_COOKIE } from '../../../lib/restaurant-auth'
import { SESSION_MAX_AGE } from '../../../lib/jwt'
import { fmFetch } from '../../../lib/fm-fetch'
import { isDiscoRestaurantArchived } from '../../../lib/disco-restaurant-auth'
import { matchesMasterPassword, recordMasterPasswordLogin } from '../../../lib/master-login'
import { classifyFmRestaurantLogin, USE_DISCO_PASSWORD, ACCOUNT_REMOVED } from '../../../lib/fm-login-scope'
import { beginDiscoPasswordSetup } from '../../../lib/staff-migration'
import { FM_PORTAL_CLEARANCE_COOKIE, signClearance, type ClearanceKind } from '../../../lib/fm-portal-clearance'
import { decodeJwtPayload } from '../../../lib/jwt'
import { sql } from '../../../lib/db'

// One row per FamilyMeal-password sign-in attempt that FamilyMeal accepted, with
// what Disco did about it — the record that did not exist when Peter asked how
// many people still sign in this way (11 Nov 2026). The master password keeps its
// own MASTER_PASSWORD_LOGIN row (lib/master-login.ts) and is not logged here.
async function recordFmPasswordSignin(email: string, restaurantReference: string | null, outcome: string): Promise<void> {
  try {
    await sql`
      INSERT INTO disco_admin_audit (action, restaurant_reference, actor_email, detail)
      VALUES ('FM_PASSWORD_SIGNIN', ${restaurantReference}, ${email}, ${JSON.stringify({ outcome })}::jsonb)
    `
  } catch (e) {
    console.error('[restaurant-auth] could not record FM_PASSWORD_SIGNIN:', e instanceof Error ? e.message : e)
  }
}

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

    // The address FAMILYMEAL authenticated — the identity every decision below
    // rests on. Never a value the client sent on its own.
    const fmEmail = String(data.email || email).trim().toLowerCase()
    const homeRef = (() => {
      const c = rawToken ? decodeJwtPayload(rawToken) : null
      return c?.restaurant ? String(c.restaurant) : null
    })()

    // ── WHO MAY HOLD A FAMILYMEAL SESSION ON THE PORTAL (11 Nov 2026) ─────────
    // Told apart by what was TYPED, checked here and only here:
    //   1. The team's master password (matchesMasterPassword — the same
    //      MASTER_PASSWORD_HASH check the Disco sign-in uses). Unchanged: an FM
    //      session exactly as before, now with its audit row.
    //   2. A FamilyMeal SUPER_ADMIN account — the team. Unchanged.
    //   3. A user whose restaurants still run on FamilyMeal. Unchanged.
    // Anyone else is a restaurant user whose restaurants are all on Disco: they
    // never get an FM session. With a Disco password they are told to use it;
    // without one they get the one-time set-password step and no session.
    let clearance: ClearanceKind
    if (matchesMasterPassword(String(password))) {
      clearance = 'master'
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null
      console.warn('[restaurant-auth] MASTER PASSWORD used for a FamilyMeal session:', fmEmail, homeRef)
      await recordMasterPasswordLogin({ restaurantReference: homeRef || '', email: fmEmail, ip, userAgent: req.headers.get('user-agent') || null })
    } else {
      const scope = await classifyFmRestaurantLogin({ email: fmEmail, role, homeRef })
      if (scope === 'team') {
        clearance = 'super-admin'
      } else if (scope === 'fm-backed') {
        clearance = 'fm-backed'
        await recordFmPasswordSignin(fmEmail, homeRef, 'fm-session')
      } else {
        await recordFmPasswordSignin(fmEmail, homeRef, scope)
        let out: NextResponse
        if (scope === 'has-disco-password') {
          out = NextResponse.json(USE_DISCO_PASSWORD, { status: 401 })
        } else if (scope === 'archived') {
          out = NextResponse.json(ACCOUNT_REMOVED, { status: 403 })
        } else {
          // FamilyMeal verified this password a moment ago, for this email: that
          // is the identity proof. One-time token, no session — nothing works
          // until the password is set through /api/restaurant/accept-invite.
          const setup = await beginDiscoPasswordSetup(fmEmail, {
            role,
            firstName: data.firstName ? String(data.firstName) : null,
            lastName: data.lastName ? String(data.lastName) : null,
            restaurantRef: homeRef,
          })
          out = setup.kind === 'needs-password'
            ? NextResponse.json({
                needsPasswordSetup: true,
                setupToken: setup.token,
                email: setup.email,
                firstName: setup.firstName,
                restaurantName: setup.restaurantName,
              })
            // Could not start the step (e.g. an account row could not be read
            // back): still no FM session.
            : NextResponse.json({ error: 'We could not start setting your Disco Cater password. Please try again, or choose "Forgot password?".', reason: 'disco-password-required' }, { status: 409 })
        }
        // Whatever FM session this browser already holds stops here too.
        out.cookies.delete(RESTAURANT_TOKEN_COOKIE)
        out.cookies.delete(RESTAURANT_REFRESH_COOKIE)
        out.cookies.delete(FM_PORTAL_CLEARANCE_COOKIE)
        return out
      }
    }

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
    const signed = await signClearance(fmEmail, clearance, SESSION_MAX_AGE)
    if (signed) resp.cookies.set(FM_PORTAL_CLEARANCE_COOKIE, signed, { ...RESTAURANT_COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
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
  resp.cookies.delete(FM_PORTAL_CLEARANCE_COOKIE)
  return resp
}
