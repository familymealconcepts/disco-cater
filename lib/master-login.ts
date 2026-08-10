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
