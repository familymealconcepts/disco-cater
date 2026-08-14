// Single source of truth for the synthetic customer_email placeholder written
// by the FM missing-row backfill (for orders with no resolvable real email —
// no customer link at all, or a since-deleted customer record). disco_orders.
// customer_email is NOT NULL, so a real value is required; these are that
// value, deliberately unusable as an email — never to be displayed, sent to,
// or grouped as if they were a real customer.
//
// ONE shared predicate + normalizer, not the same LIKE clause copied across
// nine call sites — that's exactly the failure mode (the same logic written
// twice, drifting) that produced the promo-code bug and the order_number bug
// earlier in this project. Every consumer of customer_email imports from here.

// .invalid is the IANA/RFC 2606-reserved TLD for exactly this purpose — unlike
// example.com (which resolves to a real site and could look plausible),
// nothing under .invalid can ever be registered or delivered to.
export const PLACEHOLDER_EMAIL_DOMAIN = '@disco-backfill.invalid'
// For SQL NOT LIKE / LIKE clauses (grouping exclusions).
export const PLACEHOLDER_EMAIL_SQL_PATTERN = '%@disco-backfill.invalid'

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(PLACEHOLDER_EMAIL_DOMAIN)
}

// The one normalizer for matching/joining on email (trim + lowercase) — used
// to join disco_orders to a customer by email, and to key the customer
// roster mirror. Moved here from app/api/export/customers/route.ts so the
// roster sync doesn't grow a second copy of the same logic.
export function normalizeEmail(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null
}

// DISPLAY paths (orders list, popout, order PDF, scheduled reports, CRM
// export): call this at the point of output. Returns '' for a placeholder —
// never the synthetic string — and the real value (or '') otherwise.
export function displayEmail(email: string | null | undefined): string {
  return isPlaceholderEmail(email) ? '' : (email ?? '')
}

// The two placeholder forms, keyed by why the real email is missing (encoded
// in the local-part so the distinction is free — no new column needed).
export function guestPlaceholderEmail(fmOrderReference: string): string {
  return `guest+${fmOrderReference}${PLACEHOLDER_EMAIL_DOMAIN}`
}
export function unlinkedPlaceholderEmail(fmOrderReference: string): string {
  return `unlinked+${fmOrderReference}${PLACEHOLDER_EMAIL_DOMAIN}`
}
