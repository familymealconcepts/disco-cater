// Cart-line math helpers. Mirrors FM's server-side line scaling.
//
// CONFIRMED VIA LIVE TEST ORDER on Test Kitchen 2026-05-27 (Q1 from
// docs/fm-cart-checkout-reconciliation.md § 6):
//   - "Pudding × 1 with modifiers" → subtotal $191
//   - "Pudding × 2 with same modifiers" → subtotal $382 (exactly 2×)
//   - Modifier display stays "(1)" but FM multiplies the modifier
//     cost by the meal-package count server-side.
//
// Implication: `addon.count` on the POST is the per-meal modifier
// count. FM scales it by `meal.count` when computing the line total
// server-side, so the per-line formula is:
//
//   lineTotal = (meal.price + Σ(addon.price × addon.count)) × meal.count
//             = meal.price × meal.count
//             + Σ(addon.price × addon.count × meal.count)
//
// This is precisely what RestaurantClient.tsx was already computing
// inline. These helpers just centralize the formula so the cart
// subtotal, the FM POST payload, and any future debug overlay all
// share one source of truth.
//
// FM source citations:
//   pages/public/checkout/checkout-sidebar-preview/checkout-sidebar-preview.component.html:34, 53
//   pages/public/checkout/checkout-sidebar-preview/checkout-sidebar-preview.component.ts:829-837
//   _system/_models/meal-packages/meal-package.model.ts:54-77

export interface CartAddOn {
  reference?: string
  name?: string
  /** Per-meal modifier qty (the count FM scales by meal.count). */
  count: number
  /** Per-unit modifier price (flat, not delta from base). */
  price: number
  extraItemsGroupReference?: string
}

export interface CartLine {
  /** Meal-package base price (USD). */
  price: number
  /** Meal-package qty. FM field name: `count`. We accept either
   *  `count` or `quantity` for legacy callers; new code should pass
   *  `count`. */
  count?: number
  quantity?: number
  addOns?: CartAddOn[]
}

/** Sum of (modifier.price × modifier.count) for one line, BEFORE the
 *  meal-count scaling. Useful for computing "unit price" (per-meal). */
export function lineAddonsPerMeal(line: CartLine): number {
  return (line.addOns ?? []).reduce((s, a) => s + (a.price || 0) * (a.count || 0), 0)
}

/** Per-meal price for one line — what would show if meal qty were 1.
 *  This is the `unitPrice` RestaurantClient.tsx pre-computes on each
 *  cart item; centralizing here so it can't drift. */
export function lineUnitPrice(line: CartLine): number {
  return (line.price || 0) + lineAddonsPerMeal(line)
}

/** Line total per FM's server-side math. Equal to
 *  (meal_base + Σ addon.price × addon.count) × meal_count. */
export function cartLineTotal(line: CartLine): number {
  const qty = line.count ?? line.quantity ?? 1
  return lineUnitPrice(line) * qty
}

/** Cart subtotal — sum of cartLineTotal across all lines. Equivalent
 *  to FM's server-returned `order.subtotal` before any service charge,
 *  tax, tip, or delivery fee is added. */
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + cartLineTotal(l), 0)
}

// ─── Inline test cases ───────────────────────────────────────────────
// Five representative shapes spanning the cases the spec calls for.
// All confirmed against real FM behavior; the Pudding cases were
// placed live during the Q1 verification.
//
// Case 1 — Test Kitchen "Pudding" × 1 with TestModifier
//   line = { price: 100, count: 1, addOns: [{ price: 91, count: 1 }] }
//   lineUnitPrice  → 100 + 91*1 = $191
//   cartLineTotal  → 191 * 1   = $191 ✓ matches FM
//
// Case 2 — Test Kitchen "Pudding" × 2 with same TestModifier
//   line = { price: 100, count: 2, addOns: [{ price: 91, count: 1 }] }
//   lineUnitPrice  → 100 + 91*1 = $191 (per meal)
//   cartLineTotal  → 191 * 2   = $382 ✓ matches FM (server-scaled)
//
// Case 3 — Westwoods "Burnt Ends" × 1, $0 base, multiple modifiers
//   line = { price: 0, count: 1, addOns: [
//     { name: 'BBQ Sauce', price: 5, count: 2 },
//     { name: 'Sides',     price: 8, count: 1 },
//   ] }
//   lineAddonsPerMeal → 5*2 + 8*1 = $18
//   lineUnitPrice     → 0 + 18 = $18
//   cartLineTotal     → 18 * 1 = $18
//
// Case 4 — Simple pickup line, no modifiers, multi-qty
//   line = { price: 150, count: 2 }
//   cartLineTotal → 150 * 2 = $300
//
// Case 5 — Two lines, one with modifiers, one without
//   lines = [
//     { price: 100, count: 1, addOns: [{ price: 91, count: 1 }] },  // $191
//     { price: 150, count: 2 },                                      // $300
//   ]
//   cartSubtotal → 191 + 300 = $491
