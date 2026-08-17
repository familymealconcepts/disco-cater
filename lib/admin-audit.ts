import { sql } from './db'

// Append-only audit trail for sensitive admin actions. Reuses the existing,
// purpose-built disco_admin_audit table (already created by
// lib/master-login.ts's ensureAuditTable for MASTER_PASSWORD_LOGIN — same
// schema, declared again here IF NOT EXISTS rather than exported from there,
// so this file has no dependency on the master-login module). Answers "who
// archived/restored which restaurant, and when."
export type AdminAuditAction = 'restaurant_archive' | 'restaurant_restore'

let auditTableEnsured = false
async function ensureAuditTable(): Promise<void> {
  if (auditTableEnsured) return
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

// Best-effort: a logging failure must never block or fail the underlying
// archive/restore action, so callers do not need to handle a thrown error —
// it's swallowed and logged here.
export async function logAdminAction(params: {
  action: AdminAuditAction
  restaurantReference: string
  actorEmail: string | null
  detail?: Record<string, unknown>
}): Promise<void> {
  try {
    await ensureAuditTable()
    await sql`
      INSERT INTO disco_admin_audit (action, restaurant_reference, actor_email, detail)
      VALUES (${params.action}, ${params.restaurantReference}, ${params.actorEmail ?? null},
              ${params.detail ? JSON.stringify(params.detail) : null}::jsonb)
    `
  } catch (e) {
    console.error('[admin-audit] failed to record action', params.action, params.restaurantReference,
      e instanceof Error ? e.message : e)
  }
}
