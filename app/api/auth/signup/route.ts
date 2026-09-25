import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { COOKIE_OPTS } from '../../../../lib/auth'
import { SESSION_MAX_AGE } from '../../../../lib/jwt'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import {
  CUSTOMER_COOKIE, CUSTOMER_COOKIE_OPTS,
  hashCustomerPassword, getDiscoCustomer, upsertDiscoCustomer, createCustomerSession,
  fmLogin, syncFmProfilePhoneToDigits,
} from '../../../../lib/customer-auth'
import { sendCustomerWelcome } from '../../../../lib/email/notifications'

export const runtime = 'nodejs'

// Customer sign-up (Disco-native). Creates the Neon account, obtains an FM JWT
// best-effort (for order placement), sets the session cookie, and returns the
// same payload SignupClient persists as `currentUser`.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const email = String(body?.email || '').trim().toLowerCase()
    const password = String(body?.password || '')
    const firstName = String(body?.firstName || '').trim()
    const lastName = String(body?.lastName || '').trim()
    const phoneNumber = String(body?.phoneNumber || '').trim()
    if (!email || !password || !firstName || !lastName) {
      return NextResponse.json({ error: 'First name, last name, email and password are required.' }, { status: 400 })
    }

    try { await runDiscoOrderMigrations() } catch (e) { console.error('[signup] migration warning:', e instanceof Error ? e.message : e) }

    const existing = await getDiscoCustomer(email).catch(() => null)
    if (existing) return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 })

    const passwordHash = await hashCustomerPassword(password)

    // NO FM ACCOUNT HERE — see ensureFmAccount in lib/customer-auth.ts.
    //
    // FM's /registration unconditionally sends "Welcome to FamilyMeal", and it
    // is the only way to create an FM user, so creating one at signup meant
    // every Disco customer got a FamilyMeal welcome for an account they only
    // need if they order from an FM-BACKED restaurant. Almost none do: in the
    // 30 days to 2026-09-24 there were 13 Disco-origin orders, 12 of them
    // native. The FM account is now created at the moment it is first needed.
    //
    // We still try an FM LOGIN. It costs one call and covers the customer who
    // already has a FamilyMeal account under this email and password: it links
    // them straight away, and — because they already exist — sends no welcome.
    const fm = await fmLogin(email, password)
    if (fm) waitUntil(syncFmProfilePhoneToDigits(fm))

    try {
      await upsertDiscoCustomer({
        email, passwordHash, firstName, lastName, phone: phoneNumber || null,
        fmCustomerNumber: fm?.customerNumber ?? null, fmReference: fm?.reference ?? null,
      })
    } catch (e) {
      console.error('[signup] customer insert failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to create your account. Please try again.' }, { status: 500 })
    }

    let sessionToken: string
    try { sessionToken = await createCustomerSession(email, fm?.authorization, fm?.refreshToken) }
    catch (e) { console.error('[signup] session insert failed:', e instanceof Error ? e.message : e); return NextResponse.json({ error: 'Unable to create your account. Please try again.' }, { status: 500 }) }

    // Disco's OWN welcome. waitUntil so a slow or failing mailer can never
    // block or fail a signup that has already succeeded.
    waitUntil(sendCustomerWelcome({ to: email, firstName }))

    const resp = NextResponse.json({
      authorization: fm?.authorization || '',
      refreshToken: fm?.refreshToken || '',
      email,
      firstName,
      lastName,
      phoneNumber,
      reference: fm?.reference || '',
      role: fm?.role || 'USER',
    })
    resp.cookies.set(CUSTOMER_COOKIE, sessionToken, CUSTOMER_COOKIE_OPTS)
    if (fm?.authorization) {
      resp.cookies.set('disco_token', fm.authorization, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
      if (fm.refreshToken) resp.cookies.set('disco_refresh', fm.refreshToken, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
    }
    return resp
  } catch {
    return NextResponse.json({ error: 'Unable to connect. Please try again.' }, { status: 500 })
  }
}
