// Disco-native customer authentication.
//
// Customers authenticate against Neon (bcrypt password_hash on disco_customers).
// Behind the scenes we also obtain an FM JWT and store it on the session
// (disco_customer_sessions.fm_jwt) so FM-backed order placement keeps working.
// The cookie carries an OPAQUE session token (64-char hex), never the FM JWT.
//
// This is CUSTOMER auth only — separate from disco_restaurant_token (restaurant)
// and fm_admin_token (admin). Never log passwords or JWTs.

import type { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { randomBytes, createHmac } from 'crypto'
import bcrypt from 'bcryptjs'
import { sql } from './db'
import { sanitizePhone } from './utils/phone'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const CUSTOMER_COOKIE = 'disco_customer_token'
export const CUSTOMER_SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 2592000 seconds = 30 days
export const CUSTOMER_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: CUSTOMER_SESSION_MAX_AGE,
}

// Sentinel for accounts auto-migrated from FM before we had a real hash. Login
// recognizes it and re-verifies against FM, then upgrades to a real bcrypt hash.
export const FM_MIGRATED = 'FM_MIGRATED'

const SALT_ROUNDS = 10

export async function hashCustomerPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS)
}

export async function verifyCustomerPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || hash === FM_MIGRATED) return false
  try { return await bcrypt.compare(password, hash) } catch { return false }
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex') // 64-char hex
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export interface DiscoCustomerRow {
  id: number
  email: string
  password_hash: string
  first_name: string
  last_name: string
  phone: string | null
  fm_customer_number: number | null
  fm_reference: string | null
  needs_password_reset: boolean | null
  company_name: string | null
  disabled_at: string | null
}

export async function getDiscoCustomer(email: string): Promise<DiscoCustomerRow | null> {
  const rows = (await sql`
    SELECT id, email, password_hash, first_name, last_name, phone,
           fm_customer_number, fm_reference, needs_password_reset, company_name, disabled_at
    FROM disco_customers WHERE email = ${email.toLowerCase()} LIMIT 1
  `) as DiscoCustomerRow[]
  return rows[0] ?? null
}

export async function upsertDiscoCustomer(data: {
  email: string
  passwordHash: string
  firstName: string
  lastName: string
  phone?: string | null
  fmCustomerNumber?: number | null
  fmReference?: string | null
}): Promise<void> {
  await sql`
    INSERT INTO disco_customers
      (email, password_hash, first_name, last_name, phone, fm_customer_number, fm_reference, updated_at)
    VALUES (${data.email.toLowerCase()}, ${data.passwordHash}, ${data.firstName}, ${data.lastName},
            ${data.phone ?? null}, ${data.fmCustomerNumber ?? null}, ${data.fmReference ?? null}, NOW())
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), disco_customers.first_name),
      last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), disco_customers.last_name),
      phone = COALESCE(EXCLUDED.phone, disco_customers.phone),
      fm_customer_number = COALESCE(EXCLUDED.fm_customer_number, disco_customers.fm_customer_number),
      fm_reference = COALESCE(EXCLUDED.fm_reference, disco_customers.fm_reference),
      needs_password_reset = false,
      -- Setting a password invalidates any reset in flight; this upsert writes
      -- password_hash, so it must clear the token too or a stale link would
      -- still work against the new credential.
      reset_token = NULL,
      reset_token_expires_at = NULL,
      updated_at = NOW()
  `
}

// ── Password reset (token) ───────────────────────────────────────────────────
// Deliberately mirrors setResetToken in lib/disco-restaurant-auth.ts: 32 random
// bytes, one hour. Same shape, same lifetime — a diner's reset should not
// silently behave differently from a restaurant user's.

export async function setCustomerResetToken(email: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await sql`
    UPDATE disco_customers
    SET reset_token = ${token},
        reset_token_expires_at = NOW() + INTERVAL '1 hour',
        updated_at = NOW()
    WHERE lower(email) = lower(${email})
  `
  return token
}

export interface CustomerResetAccount { email: string; first_name: string | null }

/** The customer a non-expired reset token belongs to, or null. */
export async function getCustomerByResetToken(token: string): Promise<CustomerResetAccount | null> {
  if (!token) return null
  const rows = (await sql`
    SELECT email, first_name FROM disco_customers
    WHERE reset_token = ${token} AND reset_token_expires_at > NOW()
    LIMIT 1
  `) as CustomerResetAccount[]
  return rows[0] ?? null
}

/**
 * Consume the token and set the new password in ONE statement. There are no
 * transactions here (neon HTTP), so a check-then-write pair could let the same
 * token set a password twice; the WHERE clause re-validates it at write time
 * and the same statement clears it. Returns the email on success, null if the
 * token was already used or expired.
 */
export async function setCustomerPasswordByResetToken(token: string, passwordHash: string): Promise<string | null> {
  if (!token) return null
  const rows = (await sql`
    UPDATE disco_customers
    SET password_hash = ${passwordHash},
        reset_token = NULL,
        reset_token_expires_at = NULL,
        needs_password_reset = false,
        updated_at = NOW()
    WHERE reset_token = ${token} AND reset_token_expires_at > NOW()
    RETURNING email
  `) as Array<{ email: string }>
  return rows[0]?.email ?? null
}

// Create a 30-day session row, storing the FM JWT/refresh when available.
export async function createCustomerSession(email: string, fmJwt?: string | null, fmRefresh?: string | null): Promise<string> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MAX_AGE * 1000)
  await sql`
    INSERT INTO disco_customer_sessions (session_token, customer_email, fm_jwt, fm_refresh_token, expires_at)
    VALUES (${token}, ${email.toLowerCase()}, ${fmJwt || null}, ${fmRefresh || null}, ${expiresAt.toISOString()})
  `
  return token
}

export async function deleteCustomerSession(token: string): Promise<void> {
  try { await sql`DELETE FROM disco_customer_sessions WHERE session_token = ${token}` } catch { /* best-effort */ }
}

// ── Session reads ─────────────────────────────────────────────────────────────

async function readCookie(name: string, req?: NextRequest): Promise<string | null> {
  if (req) return req.cookies.get(name)?.value ?? null
  const store = await cookies()
  return store.get(name)?.value ?? null
}

export interface CustomerSession {
  email: string
  firstName: string
  lastName: string
  fmReference: string | null
  fmJwt: string | null
  fmRefreshToken: string | null
  sessionToken: string
  isAuthenticated: true
}

// Resolve the customer session from the disco_customer_token cookie. Returns
// null when there's no token or the session is expired.
export async function getCustomerSession(req?: NextRequest): Promise<CustomerSession | null> {
  const token = await readCookie(CUSTOMER_COOKIE, req)
  if (!token) return null
  try {
    const rows = (await sql`
      SELECT s.session_token, s.customer_email, s.fm_jwt, s.fm_refresh_token,
             c.first_name, c.last_name, c.fm_reference
      FROM disco_customer_sessions s
      JOIN disco_customers c ON c.email = s.customer_email
      WHERE s.session_token = ${token} AND s.expires_at > NOW()
      LIMIT 1
    `) as Array<{
      session_token: string; customer_email: string; fm_jwt: string | null; fm_refresh_token: string | null
      first_name: string; last_name: string; fm_reference: string | null
    }>
    if (!rows.length) return null
    const r = rows[0]
    return {
      email: r.customer_email,
      firstName: r.first_name,
      lastName: r.last_name,
      fmReference: r.fm_reference,
      fmJwt: r.fm_jwt,
      fmRefreshToken: r.fm_refresh_token,
      sessionToken: r.session_token,
      isAuthenticated: true,
    }
  } catch (err) {
    console.error('[customer-auth] getCustomerSession failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// True when the JWT's exp claim is in the past. Conservative: an unparseable
// token is treated as expired so we attempt a refresh.
function jwtExpired(token: string): boolean {
  try {
    const part = token.split('.')[1]
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
    if (typeof payload.exp !== 'number') return false // no exp → assume long-lived
    return Date.now() >= payload.exp * 1000
  } catch {
    return true
  }
}

// Returns a usable FM JWT for the current customer session, refreshing via FM
// /refreshToken when the stored one is missing/expired. Returns null when the
// session is invalid or no FM JWT can be obtained (FM down with no valid token).
// Falls back to the legacy disco_token cookie during the transition.
export async function getFmCustomerJwt(req?: NextRequest): Promise<string | null> {
  const session = await getCustomerSession(req)
  if (!session) {
    // Transition fallback: legacy sessions carry the raw FM JWT in disco_token.
    return (await readCookie('disco_token', req)) ?? null
  }

  if (session.fmJwt && !jwtExpired(session.fmJwt)) return session.fmJwt

  // Attempt a background refresh against FM.
  if (session.fmRefreshToken) {
    try {
      const res = await fetch(`${FM}/refreshToken`, {
        method: 'POST',
        headers: { RefreshToken: session.fmRefreshToken, Accept: 'application/json' },
      })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        const newJwt = String(data?.authorization || '').replace(/^Bearer\s+/i, '').trim()
        const newRefresh = String(data?.refreshToken || session.fmRefreshToken).trim()
        if (newJwt) {
          try {
            await sql`
              UPDATE disco_customer_sessions
              SET fm_jwt = ${newJwt}, fm_refresh_token = ${newRefresh}
              WHERE session_token = ${session.sessionToken}
            `
          } catch { /* best-effort persist */ }
          return newJwt
        }
      }
    } catch (err) {
      console.error('[customer-auth] FM refresh failed:', err instanceof Error ? err.message : err)
    }
  }

  // Last resort: return whatever we have (FM may still accept a recently-expired
  // token), else the legacy cookie, else null.
  return session.fmJwt ?? (await readCookie('disco_token', req)) ?? null
}

// Best-effort FM /login. Returns the parsed FM payload (with stripped JWT) or
// null on any failure (bad creds, FM down). NEVER throws. NEVER logs the token.
export interface FmAuthResult {
  authorization: string
  refreshToken: string
  email: string
  firstName: string
  lastName: string
  phoneNumber: string
  reference: string
  role: string
  customerNumber: number | null
}

function mapFmAuth(body: Record<string, unknown> | null, fallback: { email: string; firstName?: string; lastName?: string; phoneNumber?: string }): FmAuthResult | null {
  const authorization = String(body?.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!authorization) return null
  const num = Number(body?.customerNumber)
  return {
    authorization,
    refreshToken: String(body?.refreshToken || '').trim(),
    email: String(body?.email || fallback.email),
    firstName: String(body?.firstName || fallback.firstName || ''),
    lastName: String(body?.lastName || fallback.lastName || ''),
    phoneNumber: String(body?.phoneNumber || fallback.phoneNumber || ''),
    reference: String(body?.reference || ''),
    role: String(body?.role || 'USER'),
    customerNumber: Number.isInteger(num) ? num : null,
  }
}

export async function fmLogin(email: string, password: string): Promise<FmAuthResult | null> {
  try {
    const res = await fetch(`${FM}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) return null
    return mapFmAuth(await res.json().catch(() => null), { email })
  } catch {
    return null
  }
}

export async function fmRegister(data: {
  email: string; password: string; firstName: string; lastName: string; phoneNumber?: string
}): Promise<FmAuthResult | null> {
  try {
    const res = await fetch(`${FM}/registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        email: data.email, password: data.password,
        // FM /registration requires a digits-only phone. Sanitize here too so
        // EVERY caller of fmRegister is safe, not just the ones that remember.
        firstName: data.firstName, lastName: data.lastName, phoneNumber: sanitizePhone(data.phoneNumber),
      }),
    })
    if (!res.ok) return null
    return mapFmAuth(await res.json().catch(() => null), data)
  } catch {
    return null
  }
}

// Self-healing: if FM has a formatted phone stored for this just-authenticated
// customer (e.g. "732-239-7055" from the legacy Angular signup), silently rewrite
// it to digits-only via PUT /api/users so the next checkout doesn't 400 on
// "Phone number has wrong format". Best-effort and fire-and-forget at the call
// site — NEVER throws, NEVER blocks login, NEVER logs the JWT.
export async function syncFmProfilePhoneToDigits(fm: FmAuthResult | null): Promise<void> {
  try {
    if (!fm?.authorization) return
    const raw = fm.phoneNumber || ''
    const digits = sanitizePhone(raw)
    // Nothing to fix when FM has no phone or it's already clean digits.
    if (!digits || digits === raw) return
    const res = await fetch(`${FM}/api/users`, {
      method: 'PUT',
      headers: { Authorization: fm.authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: fm.firstName, lastName: fm.lastName, email: fm.email, phoneNumber: digits,
      }),
    })
    console.log(`[customer-auth] FM phone self-heal for ${fm.email}: "${raw}" → "${digits}" (${res.ok ? 'ok' : `fm ${res.status}`})`)
  } catch (err) {
    console.error('[customer-auth] FM phone self-heal failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}

// ── FM account linkage, created ON DEMAND ────────────────────────────────────
//
// Signup deliberately no longer creates an FM user. The FM account exists for
// exactly one purpose — placing orders at FM-BACKED restaurants, which is the
// only path that needs an FM JWT (app/api/order/place returns on the native
// branch before the JWT is ever read). Creating one for everybody meant FM sent
// a "Welcome to FamilyMeal" to every Disco signup: 128 of the 135 people who
// signed up in the 30 days to 2026-09-24, to serve ONE FM-backed order.
//
// So the account is created at the moment it is first needed, by
// ensureFmAccount below.

/**
 * The password Disco uses for FM accounts IT created.
 *
 * Deterministic rather than stored: an FM JWT may be needed again in a later
 * session, long after the one-off registration, and re-registering is not an
 * option (FM rejects a duplicate email). Deriving it means Disco can always
 * re-authenticate without keeping a reversible secret per customer in the
 * database.
 *
 * NOT the customer's own password, and not meant to be: they never type this,
 * and Disco's own reset (customer-set-password) deliberately never touches FM,
 * so the two sides already diverge by design.
 *
 * ROTATING THE SECRET BREAKS THIS. Change FM_LINK_SECRET and Disco can no
 * longer mint JWTs for the FM accounts it created — those customers fall back
 * to the "sign in again" path, which cannot help them because they do not know
 * this password. Treat it as long-lived.
 */
function deriveFmLinkPassword(email: string): string | null {
  const secret = process.env.FM_LINK_SECRET || process.env.UNSUBSCRIBE_SECRET
  if (!secret) return null
  // Domain-separated so reusing UNSUBSCRIBE_SECRET cannot collide with the
  // unsubscribe tokens it was minted for.
  const raw = createHmac('sha256', secret).update(`fm-link:${email.trim().toLowerCase()}`).digest('base64url')
  // FM only enforces @NotBlank on password, but keep it obviously non-guessable
  // and mixed-class in case that ever tightens.
  return `Dc1!${raw.slice(0, 40)}`
}

export type EnsureFmAccountResult =
  | { ok: true; fm: FmAuthResult }
  // The email exists in FM under a password Disco does not know (a customer who
  // registered on FamilyMeal directly, or one whose FM password predates this
  // change). Signing in supplies the real password, which mints the JWT.
  | { ok: false; reason: 'needs-signin' }
  | { ok: false; reason: 'unavailable' }

/**
 * Get an FM JWT for a customer who has no usable one on their session, creating
 * the FM account if this is their first FM-backed order.
 *
 * Order matters:
 *   1. Log in with the derived password — succeeds when Disco already created
 *      this FM account on an earlier order. Tried FIRST because it is the
 *      common repeat case and costs one call.
 *   2. Register, then log in — the genuinely-new-to-FM customer. FM sends its
 *      welcome here, which is correct: this is the moment they actually become
 *      a FamilyMeal customer.
 *   3. Otherwise the email is already in FM under someone else's password →
 *      'needs-signin'. The caller turns that into a message the order UI
 *      already renders, and its existing sign-in form fixes it, because
 *      signing in runs fmLogin with the customer's REAL password.
 *
 * Customers who signed up BEFORE this change are unaffected: their FM password
 * is their Disco password, so their ordinary sign-in already puts an FM JWT on
 * the session and they never reach this function.
 */
export async function ensureFmAccount(data: {
  email: string; firstName: string; lastName: string; phoneNumber?: string | null
}): Promise<EnsureFmAccountResult> {
  const derived = deriveFmLinkPassword(data.email)
  if (!derived) {
    console.error('[customer-auth] ensureFmAccount: no FM_LINK_SECRET/UNSUBSCRIBE_SECRET set — cannot link an FM account')
    return { ok: false, reason: 'unavailable' }
  }

  const existing = await fmLogin(data.email, derived)
  if (existing) return { ok: true, fm: existing }

  const created = await fmRegister({
    email: data.email, password: derived,
    firstName: data.firstName, lastName: data.lastName,
    phoneNumber: sanitizePhone(data.phoneNumber || ''),
  })
  // fmRegister maps a response WITHOUT an authorization token to null, and FM's
  // /registration does not return one, so a successful create still lands here.
  // Log in to find out which it was.
  const after = await fmLogin(data.email, derived)
  if (after) return { ok: true, fm: after }
  if (created) return { ok: true, fm: created }

  return { ok: false, reason: 'needs-signin' }
}

/** Persist a freshly minted FM JWT so later requests in this session reuse it. */
export async function updateCustomerSessionFmTokens(
  sessionToken: string, fmJwt: string | null, fmRefresh: string | null,
): Promise<void> {
  try {
    await sql`
      UPDATE disco_customer_sessions
      SET fm_jwt = ${fmJwt || null}, fm_refresh_token = ${fmRefresh || null}
      WHERE session_token = ${sessionToken}
    `
  } catch (e) {
    // Non-fatal: the caller already has the JWT for THIS request; losing the
    // write only costs an extra mint next time.
    console.error('[customer-auth] session FM token update failed:', e instanceof Error ? e.message : e)
  }
}

/** Record the FM reference once Disco has linked an FM account. */
export async function setCustomerFmReference(email: string, fmReference: string | null): Promise<void> {
  if (!fmReference) return
  try {
    await sql`
      UPDATE disco_customers SET fm_reference = ${fmReference}
      WHERE lower(email) = lower(${email}) AND (fm_reference IS NULL OR fm_reference = '')
    `
  } catch (e) {
    console.error('[customer-auth] fm_reference update failed:', e instanceof Error ? e.message : e)
  }
}
