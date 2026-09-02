// THE single definition of "does this restaurant have a tax rate configured".
//
// It lives in its own module because TWO places must agree on it and have
// drifted before: checkConversionReadiness's settings gate ("ready to convert")
// and loadNativePricingConfig's `taxReliable` ("safe to price"). When they
// disagree, a restaurant either converts into a state where every order 409s, or
// is refused conversion for data that is perfectly correct. Both have happened.
//
// ── THE null-VS-0 DISTINCTION IS THE WHOLE POINT ───────────────────────────
// `0` is a REAL, valid rate. DeCheco's Pizzeria genuinely has no sales tax, and
// FM stores that as null percents — so a null field does NOT mean "nobody
// configured this", and code that assumes it does will block a restaurant whose
// data is right. (I made exactly that mistake on 2026-09-01 and it had to be
// reverted.)
//
// What we CAN say safely: if not one of state/local/other is a finite number,
// then nothing is configured anywhere and pricing has nothing to work from. That
// is the only condition either caller should refuse on.
//
// ── WHY ALL THREE FIELDS ───────────────────────────────────────────────────
// computeBreakdown sums state + local + other, so those three are the rate.
// Testing `stateSalesTax` alone (as both callers used to) is wrong in two
// directions: Tenkatori Sawtelle carries its real 9.75% in `localSalesTax` with
// state at 0 — reported as "state tax percent set" against the 0, never looking
// at local — and ten restaurants (Pine and Crane DTLA, Bagel Miller, Petro's
// Chili & Chips, Alfreda, Mississippi Boy Catfish & Ribs, Shinnecock Lobster
// Factory, Sip + Co East Village, Sweet Lake Biscuits, Messy, and one unnamed)
// have a real local or other rate and NO state rate at all. Under a state-only
// `taxReliable` every one of their orders would refuse with a 409.

export interface TaxRateField { percent?: number | null; fixedAmount?: number | null }

export interface TaxRatesShape {
  stateSalesTax?: TaxRateField | null
  localSalesTax?: TaxRateField | null
  otherSalesTax?: (TaxRateField & { types?: string[] }) | null
}

/**
 * The effective tax percent — state + local + other — or NULL when NOTHING is
 * configured (no object, or every field null/absent/non-numeric).
 *
 * Returns 0 for a restaurant explicitly configured at zero. Callers must treat
 * `0` and `null` differently: 0 is an answer, null is the absence of one.
 */
export function effectiveTaxPercent(t: TaxRatesShape | null | undefined): number | null {
  if (!t) return null
  const parts = [t.stateSalesTax?.percent, t.localSalesTax?.percent, t.otherSalesTax?.percent]
  const present = parts.filter(p => typeof p === 'number' && Number.isFinite(p)) as number[]
  if (!present.length) return null
  return present.reduce((a, b) => a + b, 0)
}

/**
 * Is a rate configured at all? True when at least one of state/local/other is a
 * finite number — INCLUDING an explicit 0. False only when nothing anywhere is.
 *
 * This is the predicate both the conversion gate and the pricing path refuse on.
 */
export function isTaxConfigured(t: TaxRatesShape | null | undefined): boolean {
  return effectiveTaxPercent(t) != null
}
