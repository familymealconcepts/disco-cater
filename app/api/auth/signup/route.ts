import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_OPTS } from '../../../../lib/auth'
import { SESSION_MAX_AGE } from '../../../../lib/jwt'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import {
  CUSTOMER_COOKIE, CUSTOMER_COOKIE_OPTS,
  hashCustomerPassword, getDiscoCustomer, upsertDiscoCustomer, createCustomerSession, fmRegister, fmLogin,
} from '../../../../lib/customer-auth'

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
    // FM /registration requires digits-only phone numbers ("Phone number has
    // wrong format" otherwise). Sanitize for FM; keep the entered value in Neon.
    const sanitizePhone = (phone: string) => phone.replace(/\D/g, '')
    let fm = await fmRegister({ email, password, firstName, lastName, phoneNumber: sanitizePhone(phoneNumber) })
    // Fall back to FM /login so we capture the FM JWT even when /registration
    // doesn't return one — order placement depends on the disco_token cookie.
    if (!fm) fm = await fmLogin(email, password)
    if (!fm) console.warn('[signup] FM registration unavailable — creating Disco-only account for', email)

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
