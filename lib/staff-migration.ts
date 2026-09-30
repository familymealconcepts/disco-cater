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
import { getFmSystemAdminPermittedRefs } from './restaurant-auth'
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

/** Every restaurant this login can reach, according to FamilyMeal. */
async function fmReachableRefs(v: { role: string; token: string; restaurantRef: string | null }): Promise<string[]> {
  const out = new Set<string>()
  if (v.restaurantRef) out.add(v.restaurantRef)
  if (v.role === 'SYSTEM_ADMIN' || v.role === 'SUPER_ADMIN') {
    // A GET. Returns an empty set on any failure, which — because the caller
    // requires EVERY ref to be native and treats an empty result as unknown —
    // fails closed rather than opening the flow to someone out of scope.
    const permitted = await getFmSystemAdminPermittedRefs(v.token)
    for (const r of permitted) out.add(r)
  }
  return [...out]
}

/** True only when EVERY restaurant this person reaches has converted. */
async function allConverted(refs: string[]): Promise<boolean> {
  if (!refs.length) return false
  const rows = (await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE is_disco_native) ::int AS native
    FROM disco_restaurant_cache
    WHERE restaurant_reference::text = ANY(${refs})
  `.catch(() => [])) as { total: number; native: number }[]
  const r = rows[0]
  if (!r) return false
  // Every ref must be PRESENT in the cache and native. A ref FM knows about that
  // Disco has never cached is not evidence of conversion — it is the shape of an
  // FM-backed restaurant blocked in FM, so it must fail closed.
  return r.total === refs.length && r.native === refs.length
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
    VALUES (${email}, ${sentinel}, ${ref}, ${ref}, ${v.firstName}, ${v.lastName}, ${v.role}, ${CREATED_BY_MIGRATION})
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

  const refs = await fmReachableRefs(v)
  if (!(await allConverted(refs))) return { kind: 'out-of-scope' }

  const home = v.restaurantRef || refs[0]
  if (!home) return { kind: 'out-of-scope' }

  await ensureAccountRow(email, v, home)

  // Re-read rather than trusting the caller: if this account already has a Disco
  // password, it must never be offered a new one. Nothing about that person's
  // login changes.
  const rows = (await sql`
    SELECT password_set_at, archived_at, restaurant_name, first_name
    FROM disco_restaurant_accounts WHERE lower(email) = lower(${email}) LIMIT 1
  `.catch(() => [])) as { password_set_at: string | null; archived_at: string | null; restaurant_name: string | null; first_name: string | null }[]
  const acct = rows[0]
  if (!acct || acct.archived_at || acct.password_set_at) return { kind: 'out-of-scope' }

  const nameRows = (await sql`
    SELECT name FROM disco_restaurant_cache WHERE restaurant_reference::text = ${home} LIMIT 1
  `.catch(() => [])) as { name: string | null }[]

  // One-time and time-bounded (1 hour), consumed by the existing accept-invite
  // route. No new token type, no new write path.
  const token = await setResetToken(email)
  return {
    kind: 'needs-password',
    token,
    email,
    firstName: acct.first_name ?? v.firstName,
    restaurantName: nameRows[0]?.name ?? acct.restaurant_name ?? null,
  }
}
