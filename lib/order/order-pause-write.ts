// The ONE writer for "Pause new orders" (lib/order/order-pause.ts) — used by the restaurant portal
// (/api/restaurant/order-pause) and Super Admin (/api/admin/restaurant-overrides PATCH orderPause).
// Validates, audits ('order_pause_update', before/after) and upserts disco_restaurant_overrides.
import { sql, runMigrations } from '../db'
import { logSettingsChange } from '../settings-audit'
import { buildPauseState, type OrderPauseState } from './order-pause'

export interface OrderPauseInput {
  /** YYYY-MM-DD ordering resumes (exclusive), or null to end the pause now. */
  pausedUntil: string | null
  excludedMenus?: string[]
}

export type OrderPauseWriteResult = { ok: true; state: OrderPauseState } | { ok: false; status: number; error: string }

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function readOrderPauseRow(ref: string): Promise<{ pausedUntil: string | null; excludedMenus: string[] }> {
  const rows = (await sql`
    SELECT orders_paused_until::text AS until, orders_pause_excluded_menus AS excluded
      FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
  `) as { until: string | null; excluded: string[] | null }[]
  return { pausedUntil: rows[0]?.until ?? null, excludedMenus: rows[0]?.excluded ?? [] }
}

export async function writeOrderPause(params: {
  restaurantReference: string
  input: OrderPauseInput
  actorEmail: string | null
  authType: 'disco' | 'fm' | 'admin' | 'script'
}): Promise<OrderPauseWriteResult> {
  const ref = params.restaurantReference
  const until = params.input.pausedUntil ? String(params.input.pausedUntil).slice(0, 10) : null
  if (until && !ISO_RE.test(until)) return { ok: false, status: 400, error: 'Choose the date ordering resumes.' }
  const excluded = [...new Set((params.input.excludedMenus ?? []).map(String).filter(Boolean))]
  if (excluded.some((m) => !UUID_RE.test(m))) return { ok: false, status: 400, error: 'Unknown menu in the excluded list.' }

  await runMigrations()
  const tzRows = (await sql`SELECT timezone FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as { timezone: string | null }[]
  if (!tzRows.length) return { ok: false, status: 404, error: 'Restaurant not found.' }
  const tz = tzRows[0].timezone || 'America/New_York'
  if (until && !buildPauseState(until, [], tz).active) {
    return { ok: false, status: 400, error: 'The resume date must be after today.' }
  }
  if (excluded.length) {
    const mine = (await sql`
      SELECT reference::text AS r FROM disco_menus
       WHERE restaurant_reference::text = ${ref} AND reference::text = ANY(${excluded})
    `) as { r: string }[]
    if (mine.length !== excluded.length) return { ok: false, status: 400, error: 'An excluded menu does not belong to this restaurant.' }
  }
  // Ending the pause clears the exclusions too, so a later pause never inherits them silently.
  const storedExcluded = until ? excluded : []

  const before = await readOrderPauseRow(ref)
  await logSettingsChange({
    action: 'order_pause_update',
    restaurantReference: ref,
    actorEmail: params.actorEmail,
    authType: params.authType,
    before: { orders_paused_until: before.pausedUntil, orders_pause_excluded_menus: before.excludedMenus },
    after: { orders_paused_until: until, orders_pause_excluded_menus: storedExcluded },
  })
  await sql`
    INSERT INTO disco_restaurant_overrides (restaurant_reference, orders_paused_until, orders_pause_excluded_menus, updated_at)
    VALUES (${ref}, ${until}::date, ${storedExcluded}::text[], NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE
      SET orders_paused_until = ${until}::date, orders_pause_excluded_menus = ${storedExcluded}::text[], updated_at = NOW()
  `
  return { ok: true, state: buildPauseState(until, storedExcluded, tz) }
}

/** The restaurant's menus for the excluded-menus picker: active first, then inactive, then archived. */
export async function listMenusForPause(ref: string): Promise<{ reference: string; name: string; visible: boolean; archived: boolean }[]> {
  return (await sql`
    SELECT reference::text AS reference, name, COALESCE(visible, false) AS visible, COALESCE(archived, false) AS archived
      FROM disco_menus WHERE restaurant_reference::text = ${ref}
     ORDER BY COALESCE(archived, false), COALESCE(visible, false) DESC, position NULLS LAST, name
  `.catch(() => [])) as { reference: string; name: string; visible: boolean; archived: boolean }[]
}
