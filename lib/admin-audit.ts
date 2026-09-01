import { sql } from './db'

// Append-only audit trail for sensitive admin actions. Reuses the existing,
// purpose-built disco_admin_audit table (already created by
// lib/master-login.ts's ensureAuditTable for MASTER_PASSWORD_LOGIN — same
// schema, declared again here IF NOT EXISTS rather than exported from there,
// so this file has no dependency on the master-login module). Answers "who
// archived/restored which restaurant, and when."
//
// notifications_update is the one action here written from the RESTAURANT portal
// rather than the admin portal, so its actor_email is a restaurant user (or a
// Disco staffer inside a master-password session), not an admin. It's in this
// table anyway: a notifications save is the settings write most likely to be
// disputed later ("you set this up, FM still says otherwise"), and before this
// existed, attributing one meant reconstructing it from MASTER_PASSWORD_LOGIN
// rows and disco_restaurant_overrides.updated_at by hand.
//
// Its `detail` carries { authType, before, after }. In `after`,
// adminOrderReminderEmailsEnabled: null means "the client did not send this
// field, so the stored value was preserved" — NOT "set to null". Compare
// against `before` to read the real resulting value.
//
// The *_update / stripe_disconnect family below is the settings-write trail
// added 2026-08-27 (Tier 1). All of them go through lib/settings-audit.ts,
// which documents the shared { authType, before, after } detail contract; the
// helpers there are the only thing that should be writing these actions.
export type AdminAuditAction =
  // admin portal — restaurant lifecycle
  | 'restaurant_archive' | 'restaurant_restore' | 'restaurant_permanent_delete' | 'CONVERTED_TO_NATIVE'
  // restaurant portal — settings
  | 'notifications_update' | 'disco_settings_update' | 'tax_rate_update'
  | 'online_ordering_update' | 'marketplace_visibility_update' | 'stripe_disconnect'
  // admin portal — settings
  | 'money_flow_update' | 'payout_schedule_update'
  | 'admin_overrides_update' | 'admin_cache_update'

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
