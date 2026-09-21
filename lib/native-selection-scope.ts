import { sql } from './db'

/**
 * May an FM SYSTEM_ADMIN token act on this DISCO-NATIVE reference?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * FamilyMeal decides which restaurants an FM SYSTEM_ADMIN manages
 * (getFmSystemAdminPermittedRefs -> FM's own system-admin list). A Disco-native
 * restaurant has no FM record, so it is NEVER in that set — and every caller that
 * tested membership alone therefore discarded a native selection and silently
 * fell back to the JWT's home restaurant. That is how a duplicated location's
 * Account page showed, and wrote to, the LIVE SOURCE.
 *
 * ── WHAT GRANTS THE RIGHT ───────────────────────────────────────────────────
 * The same rule commit 4a5299e established for /api/restaurant/selected-restaurant,
 * lifted here so the two cannot drift: a native reference is permitted if it
 * shares a MULTI-UNIT LINK with at least one restaurant FM already authorized this
 * token for. The right is inherited from FM's own decision and bounded by the
 * caller's chain — it cannot reach a restaurant FM did not already authorize them
 * for, and it needs no Disco identity (an FM session has none).
 *
 * A native restaurant in no chain, or in a chain containing nothing FM authorized,
 * is refused. Deliberate: with no link to a permitted restaurant there is nothing
 * establishing that this admin owns it, and guessing permissively here would hand
 * someone another operator's restaurant.
 *
 * Nativeness and the link are tested in ONE round-trip — this sits on
 * getRestaurantRef(), which is on the hot path for most portal requests.
 *
 * NEVER THROWS. A scoping lookup failure must not break a portal request; it
 * returns false and the caller falls back to its own home reference.
 */
export async function nativeSelectionAllowed(
  ref: string,
  fmPermitted: Set<string> | ReadonlySet<string>,
): Promise<boolean> {
  const target = (ref || '').trim()
  if (!target || !fmPermitted.size) return false
  const rows = (await sql`
    SELECT 1
      FROM disco_restaurant_cache c
      JOIN disco_multi_unit_link_members target
        ON target.restaurant_reference = c.restaurant_reference
      JOIN disco_multi_unit_link_members sibling
        ON sibling.link_reference = target.link_reference
     WHERE c.restaurant_reference = ${target}
       AND c.is_disco_native = true
       AND sibling.restaurant_reference = ANY(${[...fmPermitted]}::text[])
     LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length > 0
}
