import { sql } from './db'

// Order + payment history is deliberately PRESERVED on delete — these rows become
// orphaned (their restaurant_reference no longer resolves) but are retained for
// financial/audit records. Everything else (identity, config, menus, links,
// sessions) is removed.
export const PRESERVED_ON_DELETE = new Set(['disco_orders', 'disco_stripe_payments', 'fm_historical_orders'])

// Hard-delete a Disco-native restaurant's data from Neon. Used by the super-admin
// delete route when a restaurant has NO FamilyMeal record (so FM must never be
// called). Deletes every row keyed by restaurant_reference across all public
// tables that carry that column (except the preserved history tables above) —
// discovered dynamically so new tables are covered automatically. Best-effort per
// table, with a few passes so foreign-key ordering (e.g. a child row referencing an
// account) resolves without a transaction (the Neon HTTP driver runs one statement
// per round-trip). Returns { table: rowsDeleted }.
export async function deleteDiscoNativeRestaurant(ref: string): Promise<Record<string, number>> {
  if (!ref) return {}
  const cols = (await sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'restaurant_reference'
    ORDER BY table_name
  `) as { table_name: string }[]

  const tables = cols.map(c => c.table_name).filter(t => !PRESERVED_ON_DELETE.has(t))
  // Delete accounts/cache LAST (they're the likely FK parents); everything else first.
  const rootLast = new Set(['disco_restaurant_accounts', 'disco_restaurant_cache'])
  const ordered = [
    ...tables.filter(t => !rootLast.has(t)),
    ...tables.filter(t => rootLast.has(t)),
  ]

  const summary: Record<string, number> = {}
  let remaining = [...ordered]
  for (let pass = 0; pass < 3 && remaining.length; pass++) {
    const stillFailing: string[] = []
    for (const table of remaining) {
      try {
        // Table name comes from information_schema (not user input); quote defensively.
        // RETURNING 1 so the neon HTTP driver hands back one array element per
        // deleted row — an accurate count for the summary.
        const res: unknown = await (sql as unknown as { query: (t: string, p: unknown[]) => Promise<unknown> })
          .query(`DELETE FROM "${table}" WHERE restaurant_reference = $1 RETURNING 1`, [ref])
        const n = Array.isArray(res) ? res.length : ((res as { rowCount?: number })?.rowCount ?? 0)
        summary[table] = (summary[table] || 0) + n
      } catch {
        stillFailing.push(table) // retry on a later pass (FK ordering)
      }
    }
    remaining = stillFailing
  }
  return summary
}
