// Server-only: reads and writes disco_restaurant_overrides.more_info. See lib/more-info.ts.
import { sql } from './db'
import { logSettingsChange } from './settings-audit'

export async function readMoreInfo(ref: string): Promise<string | null> {
  const rows = (await sql`SELECT more_info FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`) as { more_info: string | null }[]
  return rows[0]?.more_info ?? null
}

/** Upserts only more_info; every other column on the row is left as it is. */
export async function writeMoreInfo(ref: string, value: string | null): Promise<void> {
  await sql`
    INSERT INTO disco_restaurant_overrides (restaurant_reference, more_info, updated_at)
    VALUES (${ref}, ${value}, NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE SET more_info = EXCLUDED.more_info, updated_at = NOW()
  `
}

/**
 * Writes the note and records who changed it, in the same audit table every other settings write
 * uses. Logged before the write, as disco-settings does, so a failed write still leaves the record.
 */
export async function saveMoreInfo(args: {
  ref: string
  value: string | null
  action: 'disco_settings_update' | 'admin_overrides_update'
  actorEmail: string | null
  authType: 'disco' | 'fm' | 'admin'
  extra?: Record<string, unknown>
}): Promise<void> {
  const before = { more_info: await readMoreInfo(args.ref).catch(() => null) }
  await logSettingsChange({
    action: args.action,
    restaurantReference: args.ref,
    actorEmail: args.actorEmail,
    authType: args.authType,
    before,
    after: { more_info: args.value },
    extra: { field: 'more_info', ...(args.extra ?? {}) },
  })
  await writeMoreInfo(args.ref, args.value)
}
