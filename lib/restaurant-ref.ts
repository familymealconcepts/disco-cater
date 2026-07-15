// restaurant_reference type convention (see audit item I6).
//
// A restaurant reference is stored as two different SQL types across the schema.
// This is intentional and deliberately NOT migrated: some TEXT tables hold
// slug-based references (e.g. "yosemite-ranch"), not UUIDs, so a TEXT→UUID
// conversion would fail on real rows — and the column is a PRIMARY KEY in three
// tables. Standardizing either direction would also break a large fan-out of
// casted queries for little benefit. So we keep the split and document it here.
//
//   UUID  — order / menu / payment tables:
//     disco_orders, disco_menus, disco_menu_items, disco_menu_categories,
//     disco_menu_settings, disco_modifiers, disco_modifier_groups,
//     disco_stripe_payments, disco_report_runs, disco_scheduled_reports,
//     disco_restaurant_closed_days, fm_historical_orders
//   TEXT  — restaurant profile / account tables (value may be a UUID *or* a slug):
//     disco_restaurant_accounts, disco_restaurant_cache, disco_restaurant_overrides,
//     disco_restaurant_location_access, disco_restaurant_sessions,
//     disco_customer_favorites, disco_location_links, disco_multi_unit_link_members
//   VARCHAR — recurring_orders
//
// SQL RULE for cross-group joins/filters: compare as TEXT — cast the UUID side to
// ::text. NEVER cast the TEXT side to ::uuid: it may hold a slug and would throw.
//   ✅  WHERE cache.restaurant_reference = orders.restaurant_reference::text
//   ❌  WHERE orders.restaurant_reference = cache.restaurant_reference::uuid
//
// In JS/TS, use sameRef() to compare two references regardless of source type.

export const UUID_REF_TABLES = [
  'disco_orders', 'disco_menus', 'disco_menu_items', 'disco_menu_categories',
  'disco_menu_settings', 'disco_modifiers', 'disco_modifier_groups',
  'disco_stripe_payments', 'disco_report_runs', 'disco_scheduled_reports',
  'disco_restaurant_closed_days', 'fm_historical_orders',
] as const

export const TEXT_REF_TABLES = [
  'disco_restaurant_accounts', 'disco_restaurant_cache', 'disco_restaurant_overrides',
  'disco_restaurant_location_access', 'disco_restaurant_sessions',
  'disco_customer_favorites', 'disco_location_links', 'disco_multi_unit_link_members',
  'recurring_orders',
] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// True when a reference is a UUID (vs a slug-based reference).
export function isUuidRef(ref: string | null | undefined): boolean {
  return !!ref && UUID_RE.test(String(ref).trim())
}

// Normalize a reference for JS comparison. UUIDs are case-insensitive; slugs are
// already lowercase — so trim + lowercase is safe for both.
export function normalizeRef(ref: string | null | undefined): string {
  return String(ref ?? '').trim().toLowerCase()
}

// True when two references identify the same restaurant, regardless of the column
// type they came from (UUID vs TEXT) or casing. Empty/blank refs never match.
export function sameRef(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeRef(a)
  return na !== '' && na === normalizeRef(b)
}
