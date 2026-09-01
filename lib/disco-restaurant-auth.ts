import { sql } from './db'
import { randomUUID, randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'

export interface DiscoRestaurantSession {
  restaurantReference: string
  email: string
  firstName: string | null
  lastName: string | null
  restaurantName: string | null
  // Disco-native role: 'ADMIN' (single location) or 'SYSTEM_ADMIN' (all
  // locations in the group). Driven from disco_restaurant_accounts.role.
  role: string
  // Group identifier — null until the account is grouped/promoted.
  businessName: string | null
}

// httpOnly session cookie shared by the disco-restaurant-auth routes. secure is
// gated on NODE_ENV (mirrors the FM restaurant cookie) so local http dev works.
export const DISCO_RESTAURANT_COOKIE = 'disco_restaurant_token'
export const DISCO_RESTAURANT_SESSION_MAX_AGE = 30 * 24 * 60 * 60 // seconds (30 days)
export const DISCO_RESTAURANT_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: DISCO_RESTAURANT_SESSION_MAX_AGE,
}

// Hash a password
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

// Verify a password
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

// ── Sub-admin set-password invites ───────────────────────────────────────────

export interface InviteAccount {
  email: string
  first_name: string | null
  last_name: string | null
  restaurant_reference: string
  restaurant_name: string | null
  role: string | null
  business_name: string | null
}

// Issue (or re-issue) a one-time invite token for an account, expiring in 14
// days. Was 72h — too short for an unsolicited email with no reminder and no
// resend path, which is how Glen Rock/Elmwood Park/Briscola's invites all
// died unused (see the resend-invite route for the fix to the "no resend
// path" half of that). Returns the raw token to embed in the invite link.
export async function setInviteToken(email: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await sql`
    UPDATE disco_restaurant_accounts
    SET invite_token = ${token},
        invite_token_expires_at = NOW() + INTERVAL '14 days',
        updated_at = NOW()
    WHERE email = ${email}
  `
  return token
}

// Issue a one-time PASSWORD-RESET token — same one-time-token mechanism as the
// invite (consumed by the accept-invite / set-password route), but a shorter 1h
// window. Reuses the invite_token columns so the existing getAccountByInviteToken /
// acceptInvite path validates and clears it unchanged.
export async function setResetToken(email: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await sql`
    UPDATE disco_restaurant_accounts
    SET invite_token = ${token},
        invite_token_expires_at = NOW() + INTERVAL '1 hour',
        updated_at = NOW()
    WHERE email = ${email}
  `
  return token
}

// Resolve an account by a non-expired invite token, or null.
export async function getAccountByInviteToken(token: string): Promise<InviteAccount | null> {
  if (!token) return null
  // archived_at IS NULL is a backstop, not the primary defense — archiving
  // already clears invite_token/invite_token_expires_at (see
  // lib/disco-restaurant-archive.ts), so this mostly guards a race between an
  // in-flight accept and an archive landing at the same moment.
  const rows = (await sql`
    SELECT email, first_name, last_name, restaurant_reference, restaurant_name, role, business_name
    FROM disco_restaurant_accounts
    WHERE invite_token = ${token} AND invite_token_expires_at > NOW() AND archived_at IS NULL
    LIMIT 1
  `) as InviteAccount[]
  return rows[0] ?? null
}

// Set the account password from an accepted invite: store the hash and clear the
// one-time token so the link can't be reused.
export async function acceptInvite(email: string, passwordHash: string): Promise<void> {
  await sql`
    UPDATE disco_restaurant_accounts
    SET password_hash = ${passwordHash},
        invite_token = NULL,
        invite_token_expires_at = NULL,
        updated_at = NOW()
    WHERE email = ${email}
  `
}

// The shared archive gate for portal login. Called by all three login
// routes (disco-native, accept-invite auto-login, FM-legacy) right after
// identity resolves to a restaurant_reference and before a session is
// issued — archived restaurants have no login path, full stop. Disco-native
// only: an FM-backed restaurant_reference will simply never have
// archived_at set (archive is deferred for FM-backed), so this is a safe
// no-op for that population. Never throws — an archive-check failure must
// not accidentally lock out a legitimate login, so it fails open (false).
export async function isDiscoRestaurantArchived(restaurantReference: string): Promise<boolean> {
  if (!restaurantReference) return false
  try {
    const rows = (await sql`
      SELECT 1 FROM disco_restaurant_accounts
      WHERE restaurant_reference = ${restaurantReference} AND archived_at IS NOT NULL
      LIMIT 1
    `) as unknown[]
    return rows.length > 0
  } catch (err) {
    console.error('[isDiscoRestaurantArchived] check failed — failing open:', err instanceof Error ? err.message : err)
    return false
  }
}

// Create a session token (30 day expiry)
export async function createDiscoRestaurantSession(restaurantReference: string, email: string): Promise<string> {
  console.log('[disco-session] creating session for:', email)
  const token = randomUUID()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await sql`
    INSERT INTO disco_restaurant_sessions (token, restaurant_reference, email, expires_at)
    VALUES (${token}, ${restaurantReference}, ${email}, ${expiresAt.toISOString()})
  `
  return token
}

// Validate a session token — returns session data or null.
// restaurantName/businessName now come from disco_restaurant_cache.name (the
// restaurant-scoped, always-populated source), not the per-account row —
// accounts.restaurant_name/business_name disagree across a restaurant's
// multiple admins in practice (confirmed empty query, see the migration this
// closes), cache.name doesn't. Verified separately: zero SYSTEM_ADMIN accounts
// today have no disco_restaurant_location_access rows, so nothing is still
// depending on the legacy business_name-match grouping fallback
// (getDiscoGroupAccounts) that businessName used to feed.
export async function validateDiscoRestaurantSession(token: string): Promise<DiscoRestaurantSession | null> {
  const rows = (await sql`
    SELECT s.restaurant_reference, s.email, a.first_name, a.last_name, a.role,
           c.name AS restaurant_name
    FROM disco_restaurant_sessions s
    JOIN disco_restaurant_accounts a ON a.email = s.email
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = s.restaurant_reference
    WHERE s.token = ${token} AND s.expires_at > NOW()
    LIMIT 1
  `) as Array<{
    restaurant_reference: string; email: string
    first_name: string | null; last_name: string | null; restaurant_name: string | null
    role: string | null
  }>
  if (!rows.length) return null
  return {
    restaurantReference: rows[0].restaurant_reference,
    email: rows[0].email,
    firstName: rows[0].first_name,
    lastName: rows[0].last_name,
    restaurantName: rows[0].restaurant_name,
    role: rows[0].role || 'ADMIN',
    businessName: rows[0].restaurant_name,
  }
}

// The email's domain (lowercased), or null when unparseable. Used as the
// group fallback when an account has no business_name.
export function discoEmailDomain(email: string): string | null {
  const at = email.indexOf('@')
  if (at < 0) return null
  const d = email.slice(at + 1).trim().toLowerCase()
  return d || null
}

export interface DiscoGroupAccount {
  id: number
  email: string
  restaurant_reference: string
  restaurant_name: string | null
  business_name: string | null
  role: string | null
}

// ── Explicit location access (disco_restaurant_location_access) ───────────────
// The source of truth for which restaurant_references a SYSTEM_ADMIN can see.

// All restaurant_references the email has explicit access to. Returns [] for a
// blank email (FM-native users) or on any query error — never throws.
export async function getLocationAccessRefs(email: string): Promise<string[]> {
  const e = (email || '').trim()
  if (!e) return []
  try {
    const rows = (await sql`
      SELECT restaurant_reference FROM disco_restaurant_location_access
      WHERE account_email = ${e} ORDER BY id ASC
    `) as Array<{ restaurant_reference: string }>
    return rows.map(r => r.restaurant_reference)
  } catch {
    // Table not migrated yet — caller falls back to legacy grouping.
    return []
  }
}

// Grant access to a location (idempotent via the UNIQUE constraint).
export async function grantLocationAccess(email: string, restaurantReference: string, grantedBy: string): Promise<void> {
  await sql`
    INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
    VALUES (${email}, ${restaurantReference}, ${grantedBy})
    ON CONFLICT (account_email, restaurant_reference) DO NOTHING
  `
}

// Revoke access to a location. The caller is responsible for refusing to remove
// an account's home location.
export async function revokeLocationAccess(email: string, restaurantReference: string): Promise<void> {
  await sql`
    DELETE FROM disco_restaurant_location_access
    WHERE account_email = ${email} AND restaurant_reference = ${restaurantReference}
  `
}

/**
 * How many locations this email can REACH (grant rows). The portal shell gates
 * its multi-location UI on this rather than on role: reach is a property of the
 * grant table, and a person can legitimately hold role ADMIN and still be
 * granted several locations — which is exactly how Barbara Coultas ended up
 * unable to see the second Gracious location she had a grant for.
 *
 * Never throws; 0 on any failure, which degrades to the single-location shell.
 */
export async function countLocationAccess(email: string): Promise<number> {
  const e = (email || '').trim()
  if (!e) return 0
  try {
    const rows = (await sql`
      SELECT COUNT(*)::int AS n FROM disco_restaurant_location_access WHERE account_email = ${e}
    `) as Array<{ n: number }>
    return rows[0]?.n ?? 0
  } catch {
    return 0
  }
}

// An account's home/original location — the restaurant_reference on its
// disco_restaurant_accounts row. Never removable from location access.
export async function getHomeLocationRef(email: string): Promise<string | null> {
  const rows = (await sql`
    SELECT restaurant_reference FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1
  `) as Array<{ restaurant_reference: string | null }>
  return rows[0]?.restaurant_reference ?? null
}

// All disco_restaurant_accounts / locations a SYSTEM_ADMIN can see. Prefers the
// explicit disco_restaurant_location_access table (Feature 1); falls back to the
// legacy business_name / email-domain grouping when the account has no explicit
// access rows yet (un-migrated SAs), so existing groups keep working.
// Shared by SYSTEM_ADMIN group-wide promotion and by order/location scoping so
// the two always agree on which locations a SYSTEM_ADMIN can see.
export async function getDiscoGroupAccounts(businessName: string | null, email: string): Promise<DiscoGroupAccount[]> {
  // FM-native users have no Disco identity (getRestaurantAuthContext returns an
  // empty email for them) and therefore no rows here — return empty immediately
  // so the caller falls back to the FM token's own restaurant_reference. This is
  // the regression guard: never query (or block) for a non-Disco user.
  const e = (email || '').trim()
  if (!e) return []

  // This function must NEVER throw — a scoping failure must not break login or any
  // portal request. On any error we return [] and let the caller fall back.
  //
  // Every branch below excludes archived locations (disco_restaurant_accounts.
  // archived_at IS NOT NULL) — this is a LIVE query re-run on every request (no
  // session-cached location list anywhere in this codebase), so a SYSTEM_ADMIN
  // with both an archived and an active location loses access to the archived
  // one and keeps the active one immediately, mid-session, with no re-login.
  try {
    // Explicit access wins (disco_restaurant_location_access). One row per access
    // entry (la is UNIQUE per email+ref); name comes from the restaurant cache.
    try {
      // ONE ROW PER GRANT. The previous version joined
      // disco_restaurant_accounts on restaurant_reference to test archived_at —
      // but that column is NOT unique there (Atlanta Bread Asheville has 9
      // account rows), so every grant was multiplied by the number of account
      // rows at that location: Cory's 6 DeCheco's grants returned 7 rows, and
      // kjp@atlantabread.com's 9 returned 24, with Asheville repeated 8 times.
      // /api/restaurant/locations happened to survive it by de-duping refs into
      // a Set, but any caller that counts or iterates this list (dashboard
      // sale-stats, report scope) was reading inflated data.
      //
      // Archive is now tested where archive actually lives — a RESTAURANT is
      // archived via disco_restaurant_overrides.archived_at (see
      // lib/disco-restaurant-archive.ts, and the marketplace feed which uses the
      // same column). disco_restaurant_accounts.archived_at describes one
      // ACCOUNT, so another person's archived account at the same location was
      // never a reason to hide that location from this person.
      const access = (await sql`
        SELECT la.id AS id, ${e} AS email, la.restaurant_reference AS restaurant_reference,
               COALESCE(c.name, '') AS restaurant_name,
               NULL AS business_name, 'SYSTEM_ADMIN' AS role
        FROM disco_restaurant_location_access la
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = la.restaurant_reference
        WHERE la.account_email = ${e}
          AND NOT EXISTS (
            SELECT 1 FROM disco_restaurant_overrides o
            WHERE o.restaurant_reference = la.restaurant_reference
              AND o.archived_at IS NOT NULL
          )
        ORDER BY la.id ASC
      `) as DiscoGroupAccount[]
      if (access.length) return access
    } catch {
      // Table not migrated yet / query error — fall through to legacy grouping.
    }

    const bn = (businessName || '').trim()
    if (bn) {
      return (await sql`
        SELECT id, email, restaurant_reference, restaurant_name, business_name, role
        FROM disco_restaurant_accounts WHERE business_name = ${bn} AND archived_at IS NULL
      `) as DiscoGroupAccount[]
    }
    const domain = discoEmailDomain(e)
    if (!domain) {
      return (await sql`
        SELECT id, email, restaurant_reference, restaurant_name, business_name, role
        FROM disco_restaurant_accounts WHERE email = ${e} AND archived_at IS NULL
      `) as DiscoGroupAccount[]
    }
    return (await sql`
      SELECT id, email, restaurant_reference, restaurant_name, business_name, role
      FROM disco_restaurant_accounts WHERE LOWER(SPLIT_PART(email, '@', 2)) = ${domain} AND archived_at IS NULL
    `) as DiscoGroupAccount[]
  } catch (err) {
    console.error('[getDiscoGroupAccounts] scoping lookup failed — returning empty:', err instanceof Error ? err.message : err)
    return []
  }
}

// The set of location refs a disco account may see/manage: their group accounts
// plus their own home restaurant. Takes primitives (not the auth ctx) to avoid a
// circular import with restaurant-auth-context. Used by the native Locations routes.
export async function discoGroupRefs(businessName: string | null, email: string, homeRef: string): Promise<Set<string>> {
  const group = await getDiscoGroupAccounts(businessName, email)
  return new Set([homeRef, ...group.map(g => g.restaurant_reference)].filter(Boolean))
}

// Delete a session (logout)
export async function deleteDiscoRestaurantSession(token: string): Promise<void> {
  await sql`DELETE FROM disco_restaurant_sessions WHERE token = ${token}`
}

// Whether the email currently has at least one non-expired session.
export async function hasValidDiscoRestaurantSession(email: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_sessions WHERE email = ${email} AND expires_at > NOW() LIMIT 1
  `) as unknown[]
  return rows.length > 0
}

// Get account by email
export async function getDiscoRestaurantAccount(email: string) {
  const rows = (await sql`
    SELECT * FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1
  `) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

// Create account
export async function createDiscoRestaurantAccount(data: {
  email: string
  passwordHash: string
  restaurantReference: string
  fmUserReference?: string
  firstName?: string
  lastName?: string
  phone?: string
  restaurantName?: string
}) {
  await sql`
    INSERT INTO disco_restaurant_accounts (
      email, password_hash, restaurant_reference, fm_user_reference,
      first_name, last_name, phone, restaurant_name
    ) VALUES (
      ${data.email}, ${data.passwordHash}, ${data.restaurantReference},
      ${data.fmUserReference ?? null}, ${data.firstName ?? null},
      ${data.lastName ?? null}, ${data.phone ?? null}, ${data.restaurantName ?? null}
    )
    ON CONFLICT (email) DO NOTHING
  `
}
