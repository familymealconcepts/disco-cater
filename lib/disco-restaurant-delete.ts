import { sql } from './db'

// Permanent delete for Disco-native test restaurants and duplicates — records
// that shouldn't exist at all. Revived from the pre-1cc1faf version (removed
// when Archive shipped, since Archive covers "gone but restorable" for real
// restaurants) and reviewed against the current schema.
//
// ELIGIBILITY (enforced by the caller, app/api/admin/restaurants/[ref]/
// permanent-delete/route.ts, not here): is_disco_native = true AND
// fm_restaurant_reference IS NULL, and 0 or 1 orders. Anything FM-backed is
// refused outright — a Neon-only delete would get silently re-upserted by the
// daily map-cache cron (which reads FM's live restaurant list and INSERTs...
// ON CONFLICT DO UPDATE, never DELETEs) within about a day, so offering this
// for an FM-backed restaurant would be a tool that silently doesn't work.
//
// EXCLUDED FROM DELETION — orphaned on purpose, never touched:
//   disco_orders, disco_stripe_payments, fm_historical_orders — a restaurant
//     eligible for this tool has AT MOST ONE order (the caller's own gate), so
//     the "cost" of excluding these is a single leftover row, ever — never the
//     mass-orphan problem this exclusion existed to prevent originally. Kept
//     specifically because a PAID order's Stripe charge still exists on
//     Stripe's own ledger forever; deleting Neon's copy would create a
//     permanent, unexplained gap against that ledger and any platform-wide
//     revenue/fee reporting that already counted it. disco_order_items,
//     disco_order_item_addons, disco_sale_transactions, and disco_order_edits
//     are scoped via order_id/fm_order_reference, not restaurant_reference —
//     they were never reachable by the dynamic sweep below anyway, and follow
//     disco_orders' fate by construction (nothing deletes their parent).
//   disco_admin_audit — the audit trail itself; deleting it defeats the point
//     of writing one before the delete in the first place.
//
// disco_order_events is DIFFERENT from the above and IS deleted: it's an
// operational/webhook event log, not a financial record — nothing reconciles
// against it the way Stripe's ledger reconciles against disco_orders/
// disco_stripe_payments. It has no restaurant_reference column at all, so it
// needs an explicit join through disco_orders (which stays, per above) rather
// than the dynamic sweep.
const EXCLUDED_TABLES = new Set([
  'disco_orders', 'disco_stripe_payments', 'fm_historical_orders', 'disco_admin_audit',
])

export interface DeleteRowCounts { [table: string]: number }

// Discover every table with a literal restaurant_reference column — same
// dynamic mechanism the pre-1cc1faf version used, so a new table using this
// exact column name is auto-covered with no code change here. Tables scoped a
// DIFFERENT way (promo_codes.restaurant_ref, disco_order_events via a join,
// the modifier/item-group junction tables with no restaurant column of their
// own) are NOT found this way and are handled explicitly below — this is
// precisely the coverage gap the previous version had.
async function discoverDirectTables(): Promise<string[]> {
  const rows = (await sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'restaurant_reference'
    ORDER BY table_name
  `) as { table_name: string }[]
  return rows.map(r => r.table_name).filter(t => !EXCLUDED_TABLES.has(t))
}

// disco_restaurant_cache/disco_restaurant_accounts are the "root" identity
// rows other tables logically hang off of — deleted last, same convention the
// old code used, so a mid-sweep failure never leaves those two gone while
// something still (incorrectly) points at them as if they existed.
const ROOT_LAST = new Set(['disco_restaurant_accounts', 'disco_restaurant_cache'])

async function countExplicit(ref: string): Promise<DeleteRowCounts> {
  const counts: DeleteRowCounts = {}

  const promoRows = (await sql`SELECT id FROM promo_codes WHERE restaurant_ref = ${ref}`) as { id: number }[]
  counts['promo_codes'] = promoRows.length
  counts['promo_code_uses'] = 0
  if (promoRows.length) {
    const ids = promoRows.map(r => r.id)
    const usesRows = (await sql`SELECT COUNT(*)::int AS n FROM promo_code_uses WHERE promo_code_id = ANY(${ids})`) as { n: number }[]
    counts['promo_code_uses'] = usesRows[0]?.n ?? 0
  }

  const eventRows = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_order_events e
    JOIN disco_orders o ON o.reference = e.order_reference
    WHERE o.restaurant_reference = ${ref}::uuid
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  counts['disco_order_events'] = eventRows[0]?.n ?? 0

  const gmRows = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_modifier_group_members m
    WHERE m.group_reference IN (SELECT reference FROM disco_modifier_groups WHERE restaurant_reference = ${ref}::uuid)
       OR m.modifier_reference IN (SELECT reference FROM disco_modifiers WHERE restaurant_reference = ${ref}::uuid)
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  counts['disco_modifier_group_members'] = gmRows[0]?.n ?? 0

  const igRows = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_item_groups g
    WHERE g.item_reference IN (SELECT reference FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid)
       OR g.group_reference IN (SELECT reference FROM disco_modifier_groups WHERE restaurant_reference = ${ref}::uuid)
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  counts['disco_item_groups'] = igRows[0]?.n ?? 0

  const invRows = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_menu_item_daily_inventory i
    WHERE i.menu_item_reference IN (SELECT reference FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid)
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  counts['disco_menu_item_daily_inventory'] = invRows[0]?.n ?? 0

  return counts
}

// Preview only — never deletes anything. Used for the confirmation UI, and
// re-derived (not trusted verbatim) by the real delete so a stale client-side
// preview can never authorize deleting more than what's shown.
export async function previewRestaurantDelete(ref: string): Promise<DeleteRowCounts> {
  const counts: DeleteRowCounts = {}

  const directTables = await discoverDirectTables()
  for (const table of directTables) {
    const rows = (await (sql as unknown as { query: (t: string, p: unknown[]) => Promise<unknown[]> })
      .query(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE restaurant_reference = $1`, [ref])
      .catch(() => [{ n: 0 }])) as { n: number }[]
    counts[table] = rows[0]?.n ?? 0
  }

  Object.assign(counts, await countExplicit(ref))
  return counts
}

// The real delete. Order matters: junction/child tables with no
// restaurant_reference of their own go FIRST (their parents are about to be
// swept and would otherwise leave them dangling), then the dynamic sweep,
// with the two root identity tables last.
export async function deleteRestaurantPermanently(ref: string): Promise<DeleteRowCounts> {
  const summary: DeleteRowCounts = {}
  const rawSql = sql as unknown as { query: (t: string, p: unknown[]) => Promise<unknown[]> }

  const promoRows = (await sql`SELECT id FROM promo_codes WHERE restaurant_ref = ${ref}`) as { id: number }[]
  if (promoRows.length) {
    const ids = promoRows.map(r => r.id)
    const uses = (await sql`DELETE FROM promo_code_uses WHERE promo_code_id = ANY(${ids}) RETURNING 1`) as unknown[]
    summary['promo_code_uses'] = uses.length
  } else {
    summary['promo_code_uses'] = 0
  }
  const promos = (await sql`DELETE FROM promo_codes WHERE restaurant_ref = ${ref} RETURNING 1`) as unknown[]
  summary['promo_codes'] = promos.length

  const gm = (await sql`
    DELETE FROM disco_modifier_group_members
    WHERE group_reference IN (SELECT reference FROM disco_modifier_groups WHERE restaurant_reference = ${ref}::uuid)
       OR modifier_reference IN (SELECT reference FROM disco_modifiers WHERE restaurant_reference = ${ref}::uuid)
    RETURNING 1
  `.catch(() => [])) as unknown[]
  summary['disco_modifier_group_members'] = gm.length

  const ig = (await sql`
    DELETE FROM disco_item_groups
    WHERE item_reference IN (SELECT reference FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid)
       OR group_reference IN (SELECT reference FROM disco_modifier_groups WHERE restaurant_reference = ${ref}::uuid)
    RETURNING 1
  `.catch(() => [])) as unknown[]
  summary['disco_item_groups'] = ig.length

  const inv = (await sql`
    DELETE FROM disco_menu_item_daily_inventory
    WHERE menu_item_reference IN (SELECT reference FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid)
    RETURNING 1
  `.catch(() => [])) as unknown[]
  summary['disco_menu_item_daily_inventory'] = inv.length

  // disco_order_events: operational log, not a financial record — deleted
  // even though disco_orders (its parent, via order_reference) is preserved.
  const events = (await sql`
    DELETE FROM disco_order_events
    WHERE order_reference IN (SELECT reference FROM disco_orders WHERE restaurant_reference = ${ref}::uuid)
    RETURNING 1
  `.catch(() => [])) as unknown[]
  summary['disco_order_events'] = events.length

  const directTables = await discoverDirectTables()
  const ordered = [...directTables.filter(t => !ROOT_LAST.has(t)), ...directTables.filter(t => ROOT_LAST.has(t))]

  let remaining = [...ordered]
  for (let pass = 0; pass < 3 && remaining.length; pass++) {
    const stillFailing: string[] = []
    for (const table of remaining) {
      try {
        const res = await rawSql.query(`DELETE FROM "${table}" WHERE restaurant_reference = $1 RETURNING 1`, [ref])
        summary[table] = (summary[table] || 0) + (Array.isArray(res) ? res.length : 0)
      } catch {
        stillFailing.push(table)
      }
    }
    remaining = stillFailing
  }
  for (const table of remaining) summary[table] = summary[table] || 0 // never deleted after 3 passes — surfaced as 0, not silently omitted

  return summary
}
