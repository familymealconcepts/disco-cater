// Universal master-password override for the restaurant portal login.
//
// INTENTIONALLY UNRESTRICTED per explicit product decision: no IP allowlist, no
// staff-account gating. This is a known, deliberate, temporary gap — the proper
// fix is audit-logged SUPER_ADMIN impersonation (see
// docs/revyrie-tickets/super-admin-impersonation.md), not yet built. Until that
// ships, this is the only safety net: every successful master-password login is
// recorded (see recordMasterPasswordLogin below). Never skip that call on a
// success path.
//
// The master password itself is NEVER stored in code or plaintext — only a
// SHA-256 hash lives in MASTER_PASSWORD_HASH (env var). Comparison hashes the
// entered password first (producing a fixed-length digest regardless of input
// length) and compares the two digests with crypto.timingSafeEqual, so neither
// the length nor the content of a wrong guess leaks via response timing.
import crypto from 'node:crypto'
import { sql } from './db'
import { decodeJwtPayload } from './jwt'

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

export function matchesMasterPassword(entered: string): boolean {
  const stored = process.env.MASTER_PASSWORD_HASH
  if (!stored || !entered) return false
  const enteredHash = Buffer.from(sha256Hex(entered), 'hex')
  const storedHash = Buffer.from(stored, 'hex')
  // Guard before timingSafeEqual, which throws on unequal-length buffers rather
  // than returning false — both are SHA-256 (32 bytes) unless the env var is
  // malformed, so this branch is not itself a practical timing signal.
  if (enteredHash.length !== storedHash.length) return false
  return crypto.timingSafeEqual(enteredHash, storedHash)
}

let auditTableEnsured = false
async function ensureAuditTable(): Promise<void> {
  if (auditTableEnsured) return
  // Reuses the existing, purpose-built (currently otherwise-unused) generic
  // admin-audit table rather than adding a parallel one. Idempotent, matching
  // this codebase's lazy-ensure convention elsewhere (e.g. disco_go_live_verifications).
  await sql`
    CREATE TABLE IF NOT EXISTS disco_admin_audit (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      restaurant_reference TEXT,
      actor_email TEXT,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  auditTableEnsured = true
}

// The one required compensating control for an otherwise-unrestricted bypass —
// this must never be skipped on a successful master-password login. Errors are
// logged loudly but never thrown: a logging failure must not block a login that
// has already been authenticated, but it also must never be silent (a broken
// audit trail on the ONE safety net in place is itself a serious gap).
export async function recordMasterPasswordLogin(params: {
  restaurantReference: string
  email: string
  ip: string | null
  userAgent: string | null
}): Promise<void> {
  try {
    await ensureAuditTable()
    await sql`
      INSERT INTO disco_admin_audit (action, restaurant_reference, actor_email, detail)
      VALUES (
        'MASTER_PASSWORD_LOGIN',
        ${params.restaurantReference},
        ${params.email},
        ${JSON.stringify({ ip: params.ip, userAgent: params.userAgent })}::jsonb
      )
    `
  } catch (e) {
    console.error('[master-login] FAILED to record master-password login audit entry — this is the only safety net for an unrestricted bypass:', {
      restaurantReference: params.restaurantReference, email: params.email,
    }, e instanceof Error ? e.message : e)
  }
}

// ── RESOLVING A RESTAURANT FOR AN EMAIL NEON HAS NEVER SEEN ──────────────────
// matchesMasterPassword only ever fired for an email that already resolved to a
// disco_restaurant_accounts row, so master-password entry into an FM-backed
// restaurant never went through Disco at all — it fell through to FamilyMeal's
// own /login, which accepts the master password too. That is why the audit table
// holds 296 MASTER_PASSWORD_LOGIN rows covering 41 restaurants and every one of
// them is Disco-native: the FM-backed half was invisible, not absent.
//
// This asks FamilyMeal the same question the fallback asked implicitly — "what
// does this email reach?" — and takes FM's own answer. It is the SAME source of
// truth the fallback trusted (`data.reference` / `data.role` straight out of
// FM's /login response, exactly as app/api/restaurant-auth reads them), so the
// reachable set is unchanged. Nothing is widened; the access decision still
// belongs entirely to FamilyMeal.
//
// TWO DISTINCT SECRETS, DELIBERATELY. The operator proves themselves with
// Disco's master password (MASTER_PASSWORD_HASH, checked by
// matchesMasterPassword before this is ever called). The credential used to ASK
// FamilyMeal is our own FM_MASTER_PASSWORD. They are different env vars and are
// not required to match — the entered password is never forwarded to FM, so a
// wrong guess cannot be replayed against FamilyMeal.
const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Mirrors the role gate in app/api/restaurant-auth — a diner account must not
// yield a restaurant session no matter which password opened the door.
const FM_RESTAURANT_ROLES = new Set([
  'ADMIN', 'RESTAURANT_ADMIN', 'RESTAURANT_USER', 'SYSTEM_ADMIN', 'SUPER_ADMIN',
])

export interface FmMasterTarget {
  restaurantReference: string
  role: string
  firstName: string | null
  lastName: string | null
  restaurantName: string | null
}

/**
 * Ask FamilyMeal which restaurant an email is authorized on, using our own FM
 * master credential. Returns null when FM refuses, when the account is not a
 * restaurant role, or when FM names no restaurant — every one of which must read
 * as an ordinary failed login to the caller.
 *
 * Callers MUST have already verified matchesMasterPassword(entered) — this
 * function performs no authentication of its own.
 */
export async function resolveFmMasterTarget(email: string): Promise<FmMasterTarget | null> {
  const fmPassword = process.env.FM_MASTER_PASSWORD
  if (!fmPassword) {
    console.error('[master-login] FM_MASTER_PASSWORD is not configured — cannot resolve a restaurant for an email with no Disco account row.')
    return null
  }
  try {
    const res = await fetch(`${FM_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password: fmPassword }),
      // Bounded so a hung FM cannot hold the login request open.
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    if (!data) return null

    const role = String(data.role || '')
    if (!FM_RESTAURANT_ROLES.has(role)) return null

    // ── THE RESTAURANT IS IN THE JWT, NOT IN `reference` ──────────────────────
    // FM's /login body carries `reference`, and it is the USER's reference, not
    // the restaurant's. Verified directly: 2ndjettyseafood@gmail.com logs in
    // with reference d808667d…, and FM's own /api/admin/restaurants/d808667d…
    // answers 404 RESTAURANT_NOT_FOUND, while the same login's JWT carries
    // restaurant cc716341… — a real restaurant. Scoping a session to `reference`
    // would point it at a restaurant that does not exist.
    //
    // The JWT's `restaurant` claim is the same source getRestaurantHomeRef reads
    // and the one the manage-v2 items-count fix moved to for exactly this
    // reason. It is known to come back null occasionally
    // (see lib/fm-master-admin-read.ts), so a missing claim is treated as "no
    // answer" and refuses the login rather than guessing at a target.
    const token = String(data.authorization || data.token || '').replace(/^Bearer\s+/i, '').trim()
    const claims = token ? decodeJwtPayload(token) : null
    const restaurantReference = String(claims?.restaurant || '').trim()
    if (!restaurantReference) {
      console.warn('[master-login] FM returned no `restaurant` claim for', email, '— refusing rather than guessing a target.')
      return null
    }

    return {
      restaurantReference,
      role,
      firstName: data.firstName ? String(data.firstName) : null,
      lastName: data.lastName ? String(data.lastName) : null,
      // Best-effort only: a missing name costs a blank header, never access.
      restaurantName: await fmRestaurantName(restaurantReference),
    }
  } catch (e) {
    console.error('[master-login] FM lookup failed for', email, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * The restaurant's display name, read with the SERVICE account (never the
 * operator's credential). Best-effort: FM's /login returns no name, and the
 * restaurants this path reaches are absent from disco_restaurant_cache by
 * construction — refreshRestaurantCache drops every row FamilyMeal has blocked,
 * which is 125 of the 129 the conversion queue had to insert by hand. Returns
 * null on any failure; the session is still perfectly usable without it.
 */
async function fmRestaurantName(ref: string): Promise<string | null> {
  try {
    const rows = (await sql`
      SELECT name FROM disco_restaurant_cache WHERE restaurant_reference::text = ${ref} LIMIT 1
    `) as Array<{ name: string | null }>
    if (rows[0]?.name) return rows[0].name

    const { getFmServiceAuthHeader } = await import('./fm-service-auth')
    const auth = await getFmServiceAuthHeader()
    const res = await fetch(`${FM_BASE}/api/admin/restaurants/${encodeURIComponent(ref)}`, {
      headers: { ...auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const d = await res.json().catch(() => null)
    const n = d?.businessName ?? d?.name ?? null
    return n ? String(n) : null
  } catch {
    return null
  }
}
