// Shared "restaurant is Stripe charge/payout-capable" predicate —
// stripe_account_id IS NOT NULL AND stripe_onboarding_complete = true. This
// gates payout capability (who can go live, who counts as Stripe-connected
// for the marketplace feed, who's a sync candidate) and was hand-copied as
// raw SQL into 9 separate queries before this: app/api/admin/restaurant-
// overrides, app/api/admin/sync-stripe-status (×2), app/api/admin/sync-
// stripe-status/full (×2), app/api/admin/dashboard/stats, app/api/admin/
// disco-native-orphans, lib/marketplace-readiness.ts, lib/native-
// conversion.ts — the exact shape that produced the 5-copy marketplace-
// visibility bug (each copy needing archived_at added separately). All 9
// were confirmed textually identical before centralizing.
//
// 2026-08-20: the columns themselves moved from disco_restaurant_accounts
// (per-admin, ~10 read sites resolving "the" value via ORDER BY id ASC
// LIMIT 1 — worked by luck, not guarantee) to disco_restaurant_overrides
// (restaurant-scoped, one row per restaurant, no ambiguity possible). All 9
// call sites above now query overrides, most already having it joined in
// for other fields. This is the one place to change the definition itself —
// e.g. adding a "not disabled" clause — without hunting down every site.

// Raw SQL fragment for embedding inside a WHERE/SELECT via sql.unsafe(...).
// Pass the table alias used in that query (e.g. 'a' for
// `disco_restaurant_accounts a`), or omit it when the query has none.
export function stripeReadySql(alias?: string): string {
  const p = alias ? `${alias}.` : ''
  return `${p}stripe_account_id IS NOT NULL AND ${p}stripe_onboarding_complete = true`
}

// JS-side check for an already-fetched row, for callers that read the row
// into application code first rather than filtering in SQL.
export function isStripeReady(
  row: { stripe_account_id?: string | null; stripe_onboarding_complete?: boolean | null } | null | undefined,
): boolean {
  return !!row?.stripe_account_id && row.stripe_onboarding_complete === true
}
