/**
 * Tax exemption on a native order — parsing and validating what the customer
 * entered, in one place so both checkout routes agree.
 *
 * ── DISCO IS STRICTER THAN FAMILYMEAL, DELIBERATELY ─────────────────────────
 * FM accepts any string up to VARCHAR(255) with no format check at all
 * (CheckoutDetailsRequestDto carries a bare `String taxExemptId`, and nothing in
 * the service layer validates it), and its state field is captured but never
 * required. Peter's decision is that Disco requires 6-12 DIGITS and a state.
 * That is a product decision, not a parity gap — do not relax it toward FM.
 *
 * What exemption does NOT cover: the service charge, the platform fee, delivery
 * and tips. Only what the tax rate computes. The zeroing itself lives in
 * computeBreakdown (PricingConfig.taxExempt).
 */
export const TAX_EXEMPT_ID_RE = /^\d{6,12}$/

export type TaxExemptParse =
  | { ok: true; applied: false }
  | { ok: true; applied: true; id: string; state: string }
  | { ok: false; error: string }

/** US states + DC, matching the checkout dropdown. */
const STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
  'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
  'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
])

/**
 * Read the exemption off a checkout payload. Returns `applied: false` when the
 * customer did not ask for it, an error when they did but the input is bad, and
 * the normalized pair when it is good.
 *
 * Digits are normalized by stripping separators the customer may have typed, so
 * "12-3456-789" and "123456789" are the same nine-digit id. The stored value is
 * digits only.
 */
export function parseTaxExempt(src: Record<string, unknown> | null | undefined): TaxExemptParse {
  const s = src ?? {}
  const asked = s.taxExempt === true || s.taxExemptApplied === true
  const rawId = typeof s.taxExemptId === 'string' ? s.taxExemptId : ''
  const rawState = typeof s.taxExemptState === 'string' ? s.taxExemptState : ''
  if (!asked && !rawId.trim()) return { ok: true, applied: false }

  const id = rawId.replace(/[\s\-.]/g, '')
  if (!TAX_EXEMPT_ID_RE.test(id)) {
    return { ok: false, error: 'Enter a tax exempt number of 6 to 12 digits.' }
  }
  const state = rawState.trim().toUpperCase()
  if (!STATES.has(state)) {
    return { ok: false, error: 'Select the state your tax exemption was issued in.' }
  }
  return { ok: true, applied: true, id, state }
}
