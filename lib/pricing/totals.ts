// Service charge / tip / grand-total helpers.
//
// These produce the client-side ESTIMATE shown in the cart sidebar
// before the FM order PUT comes back with the canonical server total.
// FM's response always wins on the actual checkout screen; these are
// for the preview only.
//
// Order of operations (from FM print template
// admin/manage-orders/print-summary/print-template/print-template.component.ts
// :337-402) when displayed:
//   1. Subtotal
//   2. Service charge (rate from per-menu settings)
//   3. Taxes (state + local + other)
//   4. Delivery fee
//   5. Tip
//   6. Promo discount (subtracted)
//   7. Total
//
// Important configuration locations (confirmed § 1.5 of the doc):
//   - serviceCharge %        → per-menu (selectedMenu.settings.serviceCharge)
//   - serviceChargeName      → per-menu
//   - tipOption (presets)    → per-menu
//   - tax rate               → platform-wide (no per-restaurant override)
//   - delivery fee           → per-menu / server-computed
//
// Tip base: NEEDS REVIEW — FM source returns a pre-computed
// `tipsInPrice` on the order PUT response, so the client never has to
// pick the base. For the preview we use `subtotal` (most-permissive,
// generates the smallest tip for a given percent). The actual tip
// charged to the diner is whatever FM returns post-PUT.

import { roundCurrency } from './lineItem'

/** Service charge in dollars. `subtotal` is the cart subtotal, `pct`
 *  is the service-charge percent (e.g. 5 for 5%). Source of `pct` is
 *  the active menu's `settings.serviceCharge`. */
export function computeServiceCharge(subtotal: number, pct: number): number {
  if (!pct || pct <= 0) return 0
  return roundCurrency((subtotal * pct) / 100)
}

/** Tip in dollars. `base` is whatever FM uses (likely `subtotal`);
 *  `pct` is the tip percent (e.g. 18 for 18%). Custom tips can be
 *  passed as a flat dollar amount via `flat`. */
export function computeTip(opts: { base: number; pct?: number; flat?: number }): number {
  if (typeof opts.flat === 'number') return roundCurrency(opts.flat)
  if (!opts.pct || opts.pct <= 0) return 0
  return roundCurrency((opts.base * opts.pct) / 100)
}

// ── Platform fee + tax ───────────────────────────────────────────────
// IMPORTANT: FM computes BOTH the platform fee and tax SERVER-SIDE and
// returns them on the order PUT (checkoutPricesV2 → fee,
// stateSalesTaxInPrice, localSalesTaxInPrice, otherSalesTaxInPrice —
// checkout-sidebar-preview.component.ts:723-726). There is no public
// tax-rate endpoint and no client-side rate in FM. So the CheckoutDrawer
// displays FM's server-returned values (see extractFmMoney there); these
// helpers document the expected formulas and back the inline test cases —
// they are NOT the source of the charged amount.

/** Platform fee in dollars. FM's `fee` is a flat percentage of subtotal
 *  (3% unless FM says otherwise). */
export function computePlatformFee(subtotal: number, pct = 3): number {
  if (!subtotal || subtotal <= 0) return 0
  return roundCurrency((subtotal * pct) / 100)
}

/** Sales tax in dollars. `ratePct` is the combined state+local+other
 *  percentage. A tax-exempt order is always $0 (FM zeroes tax server-side
 *  when taxExempt=true). */
export function computeTax(subtotal: number, ratePct: number, exempt = false): number {
  if (exempt || !ratePct || ratePct <= 0 || !subtotal || subtotal <= 0) return 0
  return roundCurrency((subtotal * ratePct) / 100)
}

/** Grand total estimate. NB: tax and delivery fee are server-computed
 *  on the FM PUT response; pass them in as 0 when previewing the cart
 *  before delivery info has been entered, or pass the FM-returned
 *  values once available. */
export interface GrandTotalParts {
  subtotal: number
  serviceCharge?: number
  tax?: number
  delivery?: number
  tip?: number
  discount?: number
}

export function computeGrandTotal(parts: GrandTotalParts): number {
  const s = parts.subtotal || 0
  const sc = parts.serviceCharge || 0
  const t = parts.tax || 0
  const d = parts.delivery || 0
  const tip = parts.tip || 0
  const disc = parts.discount || 0
  return roundCurrency(s + sc + t + d + tip - disc)
}

// ─── Inline test cases ───────────────────────────────────────────────
//
// Case 1 — Pudding × 1, 5% service charge, no tip
//   subtotal = 191
//   svc = computeServiceCharge(191, 5)  → 9.55
//   computeGrandTotal({ subtotal: 191, serviceCharge: 9.55 }) → 200.55
//
// Case 2 — Pudding × 2, 5% service charge, 18% tip on subtotal
//   subtotal = 382
//   svc = computeServiceCharge(382, 5)   → 19.10
//   tip = computeTip({ base: 382, pct: 18 }) → 68.76
//   computeGrandTotal({ subtotal: 382, serviceCharge: 19.10, tip: 68.76 })
//     → 469.86
//
// Case 3 — Simple pickup, no fees, no tip
//   subtotal = 300
//   computeGrandTotal({ subtotal: 300 }) → 300.00
//
// Case 4 — Delivery order with fee, tip flat $20, server-returned tax
//   subtotal = 491, service = 24.55, tax = 41.74, delivery = 15
//   tip = computeTip({ base: 0, flat: 20 }) → 20
//   computeGrandTotal({ subtotal: 491, serviceCharge: 24.55, tax: 41.74,
//                       delivery: 15, tip: 20 })
//     → 592.29
//
// Case 5 — Coupon-discounted order ($25 off)
//   subtotal = 200, discount = 25
//   computeGrandTotal({ subtotal: 200, discount: 25 }) → 175.00
//
// ─── Tip unit-convention regression cases (Part A / Part D) ──────────
// `pct` is PERCENTAGE POINTS (15 = 15%), NOT a decimal. The caller must
// pass the percentage directly — RestaurantClient previously passed
// activeTip * 100, producing a 100× tip ($1 × 15% showed $15). These
// pin the convention so it can't regress.
//
// Tip Case A — $1 subtotal × 15%  → $0.15
//   computeTip({ base: 1, pct: 15 })   = 1 * 15 / 100   = 0.15 ✓
// Tip Case B — $100 subtotal × 15% → $15.00
//   computeTip({ base: 100, pct: 15 }) = 100 * 15 / 100 = 15.00 ✓
// Tip Case C — $100 subtotal × 20% → $20.00
//   computeTip({ base: 100, pct: 20 }) = 100 * 20 / 100 = 20.00 ✓
// Tip Case D — $100 subtotal × 22% custom → $22.00
//   computeTip({ base: 100, pct: 22 }) = 100 * 22 / 100 = 22.00 ✓
// Tip Case E — tip applies to subtotal INCLUDING modifiers. FM tips on
//   `subtotal` (which already rolls in modifier cost via the cart math —
//   cartSubtotal = Σ (base + Σ addon.price×count) × meal.count). So a
//   cart of $191 (Pudding+modifiers) at 18% → computeTip({ base: 191,
//   pct: 18 }) = 34.38. Tip is NOT computed on base-only or on
//   subtotal+serviceCharge — confirmed it's subtotal-only via FM's
//   server-returned tipsInPrice (checkout-sidebar-preview.component.ts).
//
// ─── Platform fee + tax (Item 1.D) ───────────────────────────────────
// Fee Case 1 — $100 subtotal × 3% fee → $3.00
//   computePlatformFee(100, 3) = 100 * 3 / 100 = 3.00 ✓
// Tax Case 1 — $100 subtotal × 8.875% (NYC combined) → $8.88
//   computeTax(100, 8.875) = round(8.875) = 8.88 ✓
// Tax Case 2 — tax-exempt order → $0 regardless of rate; fee unaffected
//   computeTax(100, 8.875, true) = 0.00 ✓
//   computePlatformFee(100, 3)   = 3.00 ✓  (fee still applies when exempt)
// Tax Case 3 — no rate configured (0 / undefined) → $0, proceed
//   computeTax(100, 0) = 0.00 ✓
//
// NOTE: these document the formulas. The CheckoutDrawer shows FM's
// server-returned fee + (state+local+other) tax — FM computes both
// server-side, so those are the authoritative charged amounts.
