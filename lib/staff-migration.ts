// Moving restaurant staff off FamilyMeal's password and onto Disco's own.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// A staff member whose restaurants have all converted still signs into Disco
// with their FamilyMeal password: the Disco login fails, the page falls through
// to FM's /login, and the session that results is an FM one. That makes Disco
// permanently dependent on FamilyMeal for authentication, and it decides in the
// BROWSER — a caller who simply does not run the client-side fallback gets a
// different answer from one who does.
//
// So the decision moves here, behind the login endpoint. When FamilyMeal
// recognises a password Disco does not, this issues a one-time token and the
// person sets a Disco password there and then.
//
// ── THE PASSWORD IS NOT CARRIED OVER, DELIBERATELY ──────────────────────────
// Disco has the plaintext at that moment and hashing it would spare 433 people
// a reset — and it is a standard migration pattern, already used in this
// codebase for diners (app/api/fm-auth/route.ts). Peter ruled against it, and
// the reason it is a real judgement rather than a formality: FM's /login
// accepting a string does not prove the account holder typed their own secret.
// FM accepts the master password for ANY email, and 239 of 1,140 staff accounts
// are on an FM-issued TEMPORARY password. Carrying over would have had to detect
// both. Not carrying over means there is nothing to detect.
//
// ── WHAT THIS NEVER DOES ────────────────────────────────────────────────────
// It does not write to FamilyMeal. The only two FM calls are POST /login and GET
// /api/system-admin/restaurants/list, both reads — FM's password, FM's sessions
// and familymeal.com logins are all untouched, and staff keep using their FM
// password on FamilyMeal exactly as before.
//
// It also never runs for anyone who already has a Disco password: the caller
// gates on password_set_at, and the guard is repeated here.
import { sql } from './db'
import { matchesMasterPassword } from './master-login'
import { setResetToken } from './disco-restaurant-auth'
import { classifyFmRestaurantLogin, fmLoginReachableRefs } from './fm-login-scope'
import { decodeJwtPayload } from './jwt'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Same role gate as app/api/restaurant-auth — a diner never yields a restaurant
// session, whatever password opened the door.
const FM_RESTAURANT_ROLES = new Set([
  'ADMIN', 'RESTAURANT_ADMIN', 'RESTAURANT_USER', 'SYSTEM_ADMIN', 'SUPER_ADMIN',
])

// Matches lib/native-conversion.ts. A sentinel that can never equal a portal
// session's email, so a row created here can never hand anyone edit rights over
// it via the `created_by = ctx.email` checks in /api/restaurant/team.
const CREATED_BY_MIGRATION = 'fm-authorized-users-sync'

export type StaffMigrationOutcome =
  | { kind: 'not-verified' }
  | { kind: 'out-of-scope' }
  | { kind: 'needs-password'; token: string; email: string; firstName: string | null; restaurantName: string | null }

/** FM's /login, as a pure read. Returns null when FM does not accept. */
async function fmVerify(email: string, password: string): Promise<{
  role: string; firstName: string | null; lastName: string | null; token: string; restaurantRef: string | null
} | null> {
  try {
    const res = await fetch(`${FM}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const d = await res.json().catch(() => null)
    if (!d) return null
    const role = String(d.role || '')
    if (!FM_RESTAURANT_ROLES.has(role)) return null
    const token = String(d.authorization || d.token || '').replace(/^Bearer\s+/i, '').trim()
    // The restaurant is the JWT's claim, never the body's `reference` — that
    // field is the USER's reference (verified: FM answers 404 for it).
    const claims = token ? decodeJwtPayload(token) : null
    return {
      role,
      firstName: d.firstName ? String(d.firstName) : null,
      lastName: d.lastName ? String(d.lastName) : null,
      token,
      restaurantRef: claims?.restaurant ? String(claims.restaurant) : null,
    }
  } catch {
    return null
  }
}

/**
 * Ensure a row exists to hold the token. Mirrors what conversion already writes
 * for an FM authorized user — the role comes from FamilyMeal verbatim, so this
 * grants nothing FM does not already say. The hash is a sentinel: it is
 * overwritten the moment acceptInvite runs, and cannot be used to log in.
 */
async function ensureAccountRow(email: string, v: { role: string; firstName: string | null; lastName: string | null }, ref: string): Promise<void> {
  const sentinel = bcrypt.hashSync(randomUUID(), 10)
  await sql`
    INSERT INTO disco_restaurant_accounts
      (email, password_hash, restaurant_reference, fm_restaurant_reference, first_name, last_name, role, created_by)
    SELECT ${email}, ${sentinel}, ${ref}, ${ref}, ${v.firstName}, ${v.lastName}, ${v.role}, ${CREATED_BY_MIGRATION}
     WHERE NOT EXISTS (SELECT 1 FROM disco_restaurant_accounts WHERE lower(email) = lower(${email}))
    ON CONFLICT (email) DO NOTHING
  `
}

/**
 * Decide what to do with a login Disco could not authenticate.
 *
 * Returns 'not-verified' when FamilyMeal does not recognise it either (the
 * caller answers with its ordinary invalid-credentials response), 'out-of-scope'
 * when the person still has FM-backed restaurants or already has a Disco
 * password (the caller leaves the existing FM fallback alone), and
 * 'needs-password' with a one-time token otherwise.
 */
export async function evaluateStaffPasswordMigration(email: string, password: string): Promise<StaffMigrationOutcome> {
  // ── THE MASTER PASSWORD CAN NEVER SET ANYONE'S PASSWORD ──────────────────
  // Verifying against FamilyMeal proves possession of a credential, not
  // identity: the Disco team enters on behalf of admins with the master
  // password, and FM's /login accepts it for any email. Letting that reach the
  // set-password step would let whoever is at the keyboard choose an account
  // holder's password. The caller handles this case before ever calling here;
  // this guard means the rule holds even if that ordering is changed later.
  if (matchesMasterPassword(password)) return { kind: 'out-of-scope' }

  const v = await fmVerify(email, password)
  if (!v) return { kind: 'not-verified' }
  return beginDiscoPasswordSetup(email, v)
}

/**
 * The set-password step for a sign-in FamilyMeal has ALREADY verified. Shared by
 * the Disco sign-in (above) and the FamilyMeal sign-in (app/api/restaurant-auth),
 * which hands in FM's own answer instead of asking FM a second time.
 *
 * `email` must be the address FamilyMeal just authenticated — never anything the
 * client sent separately. Returns 'out-of-scope' unless every restaurant this
 * login reaches is on Disco and the account has no Disco password (the scope
 * rule lives in lib/fm-login-scope.ts). The role on any row it creates is
 * FamilyMeal's, verbatim; it never touches grants.
 */
export async function beginDiscoPasswordSetup(
  email: string,
  v: { role: string; firstName: string | null; lastName: string | null; restaurantRef: string | null },
): Promise<StaffMigrationOutcome> {
  const e = email.trim().toLowerCase()
  const scope = await classifyFmRestaurantLogin({ email: e, role: v.role, homeRef: v.restaurantRef })
  if (scope !== 'needs-password') return { kind: 'out-of-scope' }

  const home = v.restaurantRef || (await fmLoginReachableRefs({ email: e, role: v.role, homeRef: null }))[0]
  if (!home) return { kind: 'out-of-scope' }

  await ensureAccountRow(e, v, home)

  // Re-read rather than trusting the caller: if this account already has a Disco
  // password, it must never be offered a new one. Nothing about that person's
  // login changes.
  const rows = (await sql`
    SELECT email, password_set_at, archived_at, restaurant_name, first_name
    FROM disco_restaurant_accounts WHERE lower(email) = lower(${e}) LIMIT 1
  `.catch(() => [])) as { email: string; password_set_at: string | null; archived_at: string | null; restaurant_name: string | null; first_name: string | null }[]
  const acct = rows[0]
  if (!acct || acct.archived_at || acct.password_set_at) return { kind: 'out-of-scope' }

  const nameRows = (await sql`
    SELECT name FROM disco_restaurant_cache WHERE restaurant_reference::text = ${home} LIMIT 1
  `.catch(() => [])) as { name: string | null }[]

  // One-time and time-bounded (1 hour), consumed by the existing accept-invite
  // route. No new token type, no new write path. Keyed on the row's own email
  // spelling (setResetToken matches it exactly).
  const token = await setResetToken(acct.email)
  return {
    kind: 'needs-password',
    token,
    email: acct.email,
    firstName: acct.first_name ?? v.firstName,
    restaurantName: nameRows[0]?.name ?? acct.restaurant_name ?? null,
  }
}
