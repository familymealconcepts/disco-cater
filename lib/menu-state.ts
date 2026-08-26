/**
 * The ONE definition of a menu's state.
 *
 * disco_menus has exactly two state booleans — `visible` (default true) and
 * `archived` (default false) — identical in name, type and default to FM's
 * Menu.java. FM derives three tabs from that pair rather than storing a state
 * column, and MenuServiceImpl (lines 288-298) spells the derivation out:
 *
 *     .filter(Menu::isArchived)                                          // Archived
 *     .filter(m -> FALSE.equals(m.isVisible()) && FALSE.equals(m.isArchived()))  // Inactive
 *     .filter(m -> TRUE.equals(m.isVisible())  && FALSE.equals(m.isArchived()))  // Active
 *
 * Reproduced verbatim below.
 *
 * ARCHIVED WINS OVER VISIBLE, and that is load-bearing rather than tidy. The
 * two booleans are independent, so `archived = true AND visible = true` is
 * representable and one production row is in exactly that state. FM's Archived
 * filter ignores `visible` entirely, so that row belongs in Archived and
 * nowhere else. Ordering the checks archived-first is what guarantees every
 * menu lands in exactly ONE tab — a naive `visible ? active : inactive` with a
 * separate archived flag would show it twice.
 *
 * WHY A SHARED MODULE. This predicate was written out longhand in ELEVEN
 * places — the customer restaurant page, five queries in native-checkout, the
 * native delivery resolver, the go-live gate, the conversion readiness check,
 * and the portal list — which is the exact shape of defect this codebase keeps
 * paying for (two DELIVERY_LABEL maps that were both missing the same key; a
 * marketplace visibility clause pasted into five files where archived_at then
 * went missing from some of them). One definition, every consumer.
 *
 * The SQL constants are plain strings for use with `sql.unsafe(...)`, matching
 * how SCHEDULE_MENU_COLUMNS is already handled in lib/order/native-checkout.ts.
 * They contain no interpolation and never touch caller input.
 */

export type MenuState = 'active' | 'inactive' | 'archived'

/** Just the two columns any state decision needs. */
export interface MenuStateRow {
  visible?: boolean | null
  archived?: boolean | null
}

/**
 * Which single tab a menu belongs to. Total over its input: every combination
 * of the two booleans, including nulls, returns exactly one state.
 *
 * `visible` is compared with `!== false` rather than `=== true` so a NULL reads
 * as visible, matching the column's DEFAULT true and FM's own
 * `Boolean.TRUE.equals` treatment of an unset flag.
 */
export function menuState(m: MenuStateRow): MenuState {
  if (m.archived === true) return 'archived'
  return m.visible === false ? 'inactive' : 'active'
}

export const isMenuActive = (m: MenuStateRow): boolean => menuState(m) === 'active'
export const isMenuInactive = (m: MenuStateRow): boolean => menuState(m) === 'inactive'
export const isMenuArchived = (m: MenuStateRow): boolean => menuState(m) === 'archived'

/**
 * SQL for "customer-orderable": the menus a diner may actually see and buy
 * from. Byte-identical to the clause the eleven call sites already used, so
 * routing them through this is a refactor with no behavioural change —
 * confirmed empirically against all 69 production menus, not just by reading.
 *
 * DO NOT "simplify" this to `NOT archived AND visible`. `visible` is nullable,
 * and `visible = true` excludes NULL while `NOT (visible = false)` would not.
 * No production row has a NULL visible today; the clause is written to survive
 * one appearing.
 */
export const MENU_ACTIVE_SQL = 'visible = true AND archived = false'

/** The Inactive tab — parked, typically seasonal, not customer-visible. */
export const MENU_INACTIVE_SQL = 'visible = false AND archived = false'

/** The Archived tab. Ignores `visible`, exactly as FM's own filter does. */
export const MENU_ARCHIVED_SQL = 'archived = true'

/** "Not archived", for callers that care only about that half (clone, import). */
export const MENU_NOT_ARCHIVED_SQL = 'archived = false'

export const MENU_STATE_SQL: Record<MenuState, string> = {
  active: MENU_ACTIVE_SQL,
  inactive: MENU_INACTIVE_SQL,
  archived: MENU_ARCHIVED_SQL,
}

/**
 * Ordering per tab. Active and Inactive sort by `position` — the restaurant's
 * own arrangement, which is what it dragged into order. Archived sorts by
 * `updated_at DESC` instead: position describes where a menu sits in the
 * customer's list, and an archived menu is not in that list at all, so the
 * useful question becomes "what did I archive most recently".
 */
const TAB_ORDER_COLUMNS: Record<MenuState, string[]> = {
  active: ['position', 'name'],
  inactive: ['position', 'name'],
  archived: ['updated_at DESC NULLS LAST', 'name'],
}

/**
 * ORDER BY for a tab, qualified with a table alias.
 *
 * Takes the alias rather than hardcoding one because the portal list joins an
 * item-count subquery and so aliases disco_menus as `m`, while a bare query
 * would not. Unqualified names happen to be unambiguous in today's query — only
 * disco_menus has `position`/`name` — but relying on that would break the first
 * time a join introduces a column of the same name, silently, at runtime.
 */
export function menuTabOrderSql(tab: MenuState, alias?: string): string {
  const p = alias ? `${alias}.` : ''
  return TAB_ORDER_COLUMNS[tab].map(c => p + c).join(', ')
}

/** The tab's WHERE predicate, qualified the same way. */
export function menuStateSql(tab: MenuState, alias?: string): string {
  const p = alias ? `${alias}.` : ''
  return MENU_STATE_SQL[tab].replace(/\b(visible|archived)\b/g, `${p}$1`)
}

/** Human label for a state. One word per state, shared by every surface. */
export const MENU_STATE_LABEL: Record<MenuState, string> = {
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
}
