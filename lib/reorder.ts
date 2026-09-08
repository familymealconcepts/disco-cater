/**
 * Atomic reorder for any table with a `position` column.
 *
 * ONE STATEMENT, NOT A LOOP. There are no transactions in this repo — the Neon
 * HTTP driver makes BEGIN/ROLLBACK a silent no-op — so the loop-of-UPDATEs the
 * previous reorder endpoints used could fail at row 7 of 20 and leave a
 * half-applied order, which is worse than not reordering at all. `unnest …
 * WITH ORDINALITY` does the whole list in a single statement, which is atomic
 * on its own.
 *
 * The scope clause is part of the same WHERE, so a reference belonging to
 * someone else's restaurant is a no-op rather than a leak — the same property
 * the per-row endpoints had, kept.
 */
import { sql } from './db'

export type ReorderTable =
  | 'disco_menus'
  | 'disco_menu_categories'
  | 'disco_menu_items'
  | 'disco_modifier_groups'
  | 'disco_modifiers'

/** table → the column its rows are scoped by. */
const SCOPE_COLUMN: Record<ReorderTable, string> = {
  disco_menus: 'restaurant_reference',
  disco_menu_categories: 'menu_reference',
  disco_menu_items: 'category_reference',
  disco_modifier_groups: 'restaurant_reference',
  disco_modifiers: 'restaurant_reference',
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Keep only well-formed, de-duplicated references, order preserved. */
export function cleanRefs(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    const r = String(raw)
    if (!UUID_RE.test(r) || seen.has(r)) continue
    seen.add(r); out.push(r)
  }
  return out
}

/**
 * Write `references` as positions 0..n-1 within `scopeRef`. Returns how many
 * rows actually moved — a caller can compare it to references.length to detect
 * references that were not in scope.
 */
export async function applyOrder(
  table: ReorderTable, scopeRef: string, references: string[],
): Promise<number> {
  if (!references.length) return 0
  const scopeCol = SCOPE_COLUMN[table]
  // Table and column are from the closed maps above, never from user input.
  const rows = (await sql`
    UPDATE ${sql.unsafe(table)} AS t
    SET position = v.ord - 1, updated_at = NOW()
    FROM unnest(${references}::uuid[]) WITH ORDINALITY AS v(ref, ord)
    WHERE t.reference = v.ref AND t.${sql.unsafe(scopeCol)} = ${scopeRef}::uuid
    RETURNING t.reference
  `) as { reference: string }[]
  return rows.length
}

/**
 * Same, for the two join tables that carry their own order. They are keyed by a
 * pair rather than by `reference`, so they need their own statement.
 */
export async function applyItemGroupOrder(itemRef: string, groupRefs: string[]): Promise<number> {
  if (!groupRefs.length) return 0
  const rows = (await sql`
    UPDATE disco_item_groups AS t
    SET position = v.ord - 1
    FROM unnest(${groupRefs}::uuid[]) WITH ORDINALITY AS v(ref, ord)
    WHERE t.group_reference = v.ref AND t.item_reference = ${itemRef}::uuid
    RETURNING t.group_reference
  `) as { group_reference: string }[]
  return rows.length
}

export async function applyGroupMemberOrder(groupRef: string, modifierRefs: string[]): Promise<number> {
  if (!modifierRefs.length) return 0
  const rows = (await sql`
    UPDATE disco_modifier_group_members AS t
    SET position = v.ord - 1
    FROM unnest(${modifierRefs}::uuid[]) WITH ORDINALITY AS v(ref, ord)
    WHERE t.modifier_reference = v.ref AND t.group_reference = ${groupRef}::uuid
    RETURNING t.modifier_reference
  `) as { modifier_reference: string }[]
  return rows.length
}
