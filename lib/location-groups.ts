import { sql } from './db'

/**
 * WHICH GROUP EACH LOCATION BELONGS TO — Disco's own answer (Peter, 22 Oct 2026).
 *
 * A group's locations are FamilyMeal's group plus any location created in
 * Disco by, or assigned to, a member of that group; a [COPY] belongs to its
 * original's group. The group's Primary holds every one of them, and anyone who
 * holds a location also holds its copies. Seeded by
 * scripts/plan-location-groups.ts + scripts/apply-location-groups-plan.ts;
 * kept up to date by syncAfterGrant(), which every grant path calls.
 *
 * The Happy's Pizza / Savvy Sliders co-brand (FM group 131) is a group with no
 * Primary by Peter's decision: its locations are recorded so they are never
 * mistaken for another group's, and nobody is granted anything for it.
 */

const INTERNAL = /@(familymeal|discocater)\.com$/i
let ensured = false

export async function ensureLocationGroups(): Promise<void> {
  if (ensured) return
  await sql`
    CREATE TABLE IF NOT EXISTS disco_location_groups (
      restaurant_reference TEXT PRIMARY KEY,
      fm_group_id TEXT NOT NULL,
      source TEXT NOT NULL,          -- how it was placed: fm-cobrand-link, primary-list, link-settled, copy-of-original, adopted-by-holders, created-in-group
      copy_of TEXT,                  -- for a [COPY]: the original's reference
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`CREATE INDEX IF NOT EXISTS idx_disco_location_groups_group ON disco_location_groups (fm_group_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_disco_location_groups_copy ON disco_location_groups (copy_of)`
  ensured = true
}

/** "[COPY] Tap 42 - Aventura" / "Tap 42 - Aventura (Copy)" -> "Tap 42 - Aventura"; null when not a copy. */
export function copyOriginalName(name: string | null | undefined): string | null {
  const n = String(name || '').trim()
  if (!/^\[copy\]/i.test(n) && !/\(copy\)\s*(\[archived\])?$/i.test(n)) return null
  return n.replace(/^\[copy\]\s*/i, '').replace(/\s*\[archived\]\s*$/i, '').replace(/\s*\(copy\)\s*$/i, '').trim() || null
}

/** Record a brand-new location (created or copied in Disco) in a group. */
export async function placeNewLocation(ref: string, opts: { copyOf?: string | null; creatorEmail?: string | null }): Promise<void> {
  try {
    await ensureLocationGroups()
    if (opts.copyOf) {
      await sql`
        INSERT INTO disco_location_groups (restaurant_reference, fm_group_id, source, copy_of)
        SELECT ${ref}, fm_group_id, 'copy-of-original', ${opts.copyOf} FROM disco_location_groups WHERE restaurant_reference = ${opts.copyOf}
        ON CONFLICT (restaurant_reference) DO NOTHING`
      return
    }
    const g = opts.creatorEmail ? await soleGroupOf(opts.creatorEmail) : null
    if (g) {
      await sql`
        INSERT INTO disco_location_groups (restaurant_reference, fm_group_id, source)
        VALUES (${ref}, ${g}, 'created-in-group') ON CONFLICT (restaurant_reference) DO NOTHING`
    }
  } catch (e) {
    console.error('[location-groups] placeNewLocation failed:', ref, e instanceof Error ? e.message : e)
  }
}

/** The one group a person belongs to, or null when none or several (internal staff: never). */
async function soleGroupOf(email: string): Promise<string | null> {
  const e = (email || '').trim().toLowerCase()
  if (!e || INTERNAL.test(e)) return null
  const rows = (await sql`
    SELECT DISTINCT lg.fm_group_id g
      FROM disco_location_groups lg
     WHERE lg.restaurant_reference IN (
             SELECT restaurant_reference FROM disco_restaurant_location_access WHERE lower(account_email) = ${e}
             UNION
             SELECT restaurant_reference FROM disco_restaurant_accounts WHERE lower(email) = ${e} AND upper(coalesce(role,'ADMIN')) <> 'SYSTEM_ADMIN'
           )
  `) as Array<{ g: string }>
  return rows.length === 1 ? rows[0].g : null
}

/**
 * Keep the group rules true after `email` was given `refs`. Never removes
 * anything and never throws (a grant that succeeded is not undone by this).
 *  1. An unplaced location joins the grantee's group when they belong to
 *     exactly one.
 *  2. The location's group's Primary is given it (not the co-brand, which has
 *     no Primary).
 *  3. The grantee is given every copy of each location.
 */
export async function syncAfterGrant(email: string, refs: string[]): Promise<void> {
  const e = (email || '').trim().toLowerCase()
  if (!e || !refs.length) return
  try {
    await ensureLocationGroups()
    const g = await soleGroupOf(e)
    if (g) {
      await sql`
        INSERT INTO disco_location_groups (restaurant_reference, fm_group_id, source)
        SELECT r, ${g}, 'adopted-by-holders' FROM unnest(${refs}::text[]) AS r
        ON CONFLICT (restaurant_reference) DO NOTHING`
    }
    await sql`
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
      SELECT lower(a.email), lg.restaurant_reference, 'location-groups:primary'
        FROM disco_location_groups lg
        JOIN disco_restaurant_accounts a
          ON a.is_primary_system_admin = TRUE AND a.archived_at IS NULL AND a.fm_group_id = lg.fm_group_id
       WHERE lg.restaurant_reference = ANY(${refs}::text[])
         AND lower(a.email) <> ${e}
      ON CONFLICT (account_email, restaurant_reference) DO NOTHING`
    await sql`
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
      SELECT ${e}, c.restaurant_reference, 'location-groups:copy'
        FROM disco_location_groups c
       WHERE c.copy_of = ANY(${refs}::text[])
         AND NOT EXISTS (SELECT 1 FROM disco_restaurant_overrides o WHERE o.restaurant_reference = c.restaurant_reference AND o.archived_at IS NOT NULL)
      ON CONFLICT (account_email, restaurant_reference) DO NOTHING`
  } catch (err) {
    console.error('[location-groups] syncAfterGrant failed:', e, err instanceof Error ? err.message : err)
  }
}
