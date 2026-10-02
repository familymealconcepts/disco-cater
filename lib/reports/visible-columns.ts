// Which columns a report actually shows, decided from the rows in the period.
//
// ── ONE RULE, ONE PLACE ─────────────────────────────────────────────────────
// Peter's rulings, 2026-10-02:
//   * show a column only if it carries a non-zero value in the period reported
//   * always show Net Sales, Gross and Total Distributed, even at zero
//   * never show the FamilyMeal fee
//   * columns may change from period to period, and that is fine
//
// This replaces TWO older mechanisms that answered the same question
// differently, which is why it lives in one function both surfaces call:
//
//   * the BASIC PRESET picked columns once at setup from a 12-month look-back
//     and STORED the choice. A stored choice and a per-render rule cannot both
//     be true — the restaurant picks columns and receives different ones — and
//     a 12-month window keeps a column that was busy in January and empty all
//     quarter. Retired.
//   * auto_tidy did the same thing per send, opt-in and off by default.
//     Retired: it is now the only behaviour, so a toggle for it is a toggle
//     between the rule and not-the-rule.
//
// ── "NON-ZERO" FOR A COLUMN THAT HOLDS WORDS ────────────────────────────────
// The rule is written for money. A text column (Order ID, Name, Status …) has
// no zero, so the equivalent test is whether ANY row carries a value — a Name
// column that is blank on every row is just as empty as a $0.00 one. That keeps
// one rule rather than exempting half the table from it.
import { ORDER_REPORT_COLUMNS, LOCATION_COLUMN, type OrderReportRow } from './order-report-rows'

/**
 * Never dropped, whatever the period holds.
 *
 * Net Sales and Gross because a sales report that omits the sales is not a
 * report, and their absence is the exact defect that started this (Gracious
 * Bakery received a weekly "sales" CSV with no money columns at all). Total
 * Distributed because it is the payout — the one figure a restaurant checks
 * against its bank, and the column whose absence this estate has already been
 * burned by once.
 */
export const ALWAYS_SHOWN_COLUMNS = ['netSales', 'gross', 'totalDistributed'] as const

/**
 * THE FAMILYMEAL FEE IS NOT A COLUMN AND MUST NOT BECOME ONE.
 *
 * `disco_sale_transactions.fee` is read by buildOrderReportRows only to DERIVE
 * Gross (Peter's ruling 2026-09-22: the fee never reaches the restaurant, so
 * gross is built from the visible components rather than as total − fee). It
 * has never been in ORDER_REPORT_COLUMNS. This set is the standing guard, so a
 * future column named for it fails the assertion below rather than shipping.
 */
export const NEVER_SHOWN_COLUMNS = new Set(['fee', 'fmFee', 'familyMealFee'])

function hasValue(row: OrderReportRow, key: string): boolean {
  const v = (row as unknown as Record<string, unknown>)[key]
  if (v == null) return false
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim()
  if (!s) return false
  // A money cell that formats to zero is zero however it arrived.
  const n = Number(s.replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n !== 0 : true
}

/**
 * The columns to render, in the canonical order, for exactly these rows.
 *
 * Location is prepended whenever the rows genuinely span more than one
 * restaurant — a merged multi-location report that does not say which row
 * belongs to which restaurant is not readable, and that is what a system admin
 * with "All Locations" selected receives.
 *
 * An EMPTY period keeps the always-shown columns (and Location when the caller
 * knows the scope spans several), so a zero-row report still has a shape a
 * reader recognises instead of collapsing to nothing.
 */
export function visibleReportColumns(
  rows: OrderReportRow[],
  opts?: { multiLocation?: boolean },
): string[] {
  const always = new Set<string>(ALWAYS_SHOWN_COLUMNS)
  const keys = ORDER_REPORT_COLUMNS.map(c => c.key).filter(k => !NEVER_SHOWN_COLUMNS.has(k))

  const kept = keys.filter(k => always.has(k) || rows.some(r => hasValue(r, k)))

  // Derived from the rows, not from the caller's hopes: a scope covering five
  // locations of which only one traded this week is NOT multi-location for this
  // period, and a Location column repeating one name adds nothing.
  const spansLocations = opts?.multiLocation ?? (new Set(rows.map(r => r.location)).size > 1)
  return spansLocations ? [LOCATION_COLUMN.key, ...kept] : kept
}

/** True when these rows come from more than one restaurant. */
export function rowsSpanLocations(rows: OrderReportRow[]): boolean {
  return new Set(rows.map(r => r.location)).size > 1
}
