import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_OPTS } from '../../../lib/auth'
import { SESSION_MAX_AGE } from '../../../lib/jwt'
import { runDiscoOrderMigrations } from '../../../lib/db'
import {
  CUSTOMER_COOKIE, CUSTOMER_COOKIE_OPTS, FM_MIGRATED,
  hashCustomerPassword, verifyCustomerPassword,
  getDiscoCustomer, upsertDiscoCustomer, createCustomerSession, deleteCustomerSession,
  fmLogin, fmRegister, type FmAuthResult,
} from '../../../lib/customer-auth'

export const runtime = 'nodejs'

// Disco-native customer auth. Customers authenticate against Neon
// (disco_customers); we also obtain + store an FM JWT on the session so order
// placement keeps working. The customer experience / response shape is unchanged.
//
// Cookies set:
//   disco_customer_token — opaque Neon session token (the new source of truth)
//   disco_token/disco_refresh — the FM JWT (transition compat: many routes still
//     read disco_token directly; getFmCustomerJwt() is the forward path).

function setCustomerCookies(resp: NextResponse, sessionToken: string, fm?: FmAuthResult | null) {
  resp.cookies.set(CUSTOMER_COOKIE, sessionToken, CUSTOMER_COOKIE_OPTS)
  if (fm?.authorization) {
    resp.cookies.set('disco_token', fm.authorization, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
    if (fm.refreshToken) resp.cookies.set('disco_refresh', fm.refreshToken, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
  }
}

function userPayload(email: string, fm: FmAuthResult | null, c: { first_name: string; last_name: string; phone: string | null; fm_reference: string | null } | null, fallback: { firstName: string; lastName: string; phoneNumber: string }) {
  return {
    reference: fm?.reference || c?.fm_reference || '',
    email,
    firstName: c?.first_name || fm?.firstName || fallback.firstName,
    lastName: c?.last_name || fm?.lastName || fallback.lastName,
    phoneNumber: c?.phone || fm?.phoneNumber || fallback.phoneNumber,
    role: fm?.role || 'USER',
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }

  const action = String(body?.action || 'login')
  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')
  const firstName = String(body?.firstName || '').trim()
  const lastName = String(body?.lastName || '').trim()
  const phoneNumber = String(body?.phoneNumber || '').trim()

  try { await runDiscoOrderMigrations() } catch (e) { console.error('[fm-auth] migration warning:', e instanceof Error ? e.message : e) }

  try {
    if (action === 'register') {
      // ── PART 2: REGISTRATION ──
      if (!email || !password || !firstName || !lastName) {
        return NextResponse.json({ error: 'First name, last name, email and password are required.' }, { status: 400 })
      }
      const existing = await getDiscoCustomer(email).catch(() => null)
      if (existing) {
        return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 409 })
      }
      const passwordHash = await hashCustomerPassword(password)
      // Also create the FM account (needed for order placement). Best-effort: if
      // FM is down we still create the Disco account + session, just no fm_jwt.
      // FM /registration requires a digits-only phone ("Phone number has wrong
      // format" otherwise); sanitize for FM, keep the entered value in Neon.
      const sanitizePhone = (phone: string) => phone.replace(/\D/g, '')
      let fm = await fmRegister({ email, password, firstName, lastName, phoneNumber: sanitizePhone(phoneNumber) })
      // FM may create the account but not return a JWT from /registration (or the
      // email already exists in FM). Fall back to an FM /login so we still capture
      // the FM JWT — order placement (disco_token / order/place) depends on it.
      if (!fm) fm = await fmLogin(email, password)
      if (!fm) console.warn('[fm-auth] FM registration unavailable — creating Disco-only account for', email)

      try {
        await upsertDiscoCustomer({
          email, passwordHash, firstName, lastName, phone: phoneNumber || null,
          fmCustomerNumber: fm?.customerNumber ?? null, fmReference: fm?.reference ?? null,
        })
      } catch (e) {
        console.error('[fm-auth] customer insert failed:', e instanceof Error ? e.message : e)
        return NextResponse.json({ error: 'Unable to create your account. Please try again.' }, { status: 500 })
      }

      let sessionToken: string
      try { sessionToken = await createCustomerSession(email, fm?.authorization, fm?.refreshToken) }
      catch (e) { console.error('[fm-auth] session insert failed:', e instanceof Error ? e.message : e); return NextResponse.json({ error: 'Unable to create your account. Please try again.' }, { status: 500 }) }

      const resp = NextResponse.json(userPayload(email, fm, null, { firstName, lastName, phoneNumber }))
      setCustomerCookies(resp, sessionToken, fm)
      return resp
    }

    // ── PART 3: LOGIN ──
    if (!email || !password) return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })

    const customer = await getDiscoCustomer(email).catch(() => null)
    const isSentinel = !!customer && customer.password_hash === FM_MIGRATED
    let fm: FmAuthResult | null = null

    if (customer && !isSentinel) {
      // Local verification.
      const ok = await verifyCustomerPassword(password, customer.password_hash)
      if (!ok) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
      // Authenticated locally → still attempt FM login to get a fresh fm_jwt.
      fm = await fmLogin(email, password)
    } else {
      // Not found in Neon (un-migrated FM customer) OR migrated sentinel → verify
      // against FM. We have the plaintext here, so store a REAL bcrypt hash
      // (better than the FM_MIGRATED placeholder — avoids a 2nd-login lockout).
      fm = await fmLogin(email, password)
      if (!fm) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
      const passwordHash = await hashCustomerPassword(password)
      try {
        await upsertDiscoCustomer({
          email, passwordHash, firstName: fm.firstName, lastName: fm.lastName, phone: fm.phoneNumber || null,
          fmCustomerNumber: fm.customerNumber, fmReference: fm.reference,
        })
      } catch (e) {
        // Best-effort migration write — don't fail the login because Neon is slow.
        console.error('[fm-auth] auto-migrate write failed (non-fatal):', e instanceof Error ? e.message : e)
      }
    }

    let sessionToken: string
    try { sessionToken = await createCustomerSession(email, fm?.authorization, fm?.refreshToken) }
    catch (e) { console.error('[fm-auth] session insert failed:', e instanceof Error ? e.message : e); return NextResponse.json({ error: 'Unable to log in. Please try again.' }, { status: 500 }) }

    const c = (await getDiscoCustomer(email).catch(() => null)) || customer
    const resp = NextResponse.json(userPayload(email, fm, c, { firstName, lastName, phoneNumber }))
    setCustomerCookies(resp, sessionToken, fm)
    return resp
  } catch (err) {
    console.error('[fm-auth] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to connect. Please try again.' }, { status: 500 })
  }
}

// ── PART 6: LOGOUT ──
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(CUSTOMER_COOKIE)?.value
  if (token) await deleteCustomerSession(token)
  const resp = NextResponse.json({ ok: true })
  resp.cookies.set(CUSTOMER_COOKIE, '', { ...CUSTOMER_COOKIE_OPTS, maxAge: 0 })
  resp.cookies.set('disco_token', '', { ...COOKIE_OPTS, maxAge: 0 })
  resp.cookies.set('disco_refresh', '', { ...COOKIE_OPTS, maxAge: 0 })
  return resp
}
