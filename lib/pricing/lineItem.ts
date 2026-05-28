// Line-item pricing helpers — single source of truth for any Disco Cater
// surface that displays an order line.
//
// Mirrors FM's order-details / receipt / print-summary templates. All
// three FM surfaces compute and display line totals the SAME way:
//   - Meal package line row:    price × count
//   - Modifier sub-row (each):  modifier.price × modifier.count
//
// FM source citations:
//   shared/order-details/order-details.component.html:284 (meal line)
//   shared/order-details/order-details.component.html:290 (modifier row)
//   pages/private/user/order-history/order-history-details/...html:42-43
//   admin/dashboard/print-sales-summary/...print-summary-template.html:140,148
//
// Field-name spec (FM `_system/_models/order/print-summary.model.ts:13-19`
// and the deployed /api/orders/{ref} response):
//   - The meal-package line carries `name`, `count`, `price`, `orderAddOns[]`,
//     and `comment`. NO server-computed `lineTotal` / `linePrice` — the
//     frontend multiplies.
//   - Each modifier object carries `name`, `count`, `price`, `salesCategory`.
//
// History note (the Westwoods BBQ bug): Disco Cater used `quantity` and
// `extraItems` here, which are not the FM field names. The fallbacks
// (`?? 1`, `?? []`) silently masked the missing data — meal line always
// rendered as qty 1, modifiers never rendered at all.

export interface OrderLineModifier {
  name?: string
  /** Count of this modifier within one ordered meal package. FM: `count`. */
  count?: number
  /** Legacy field name used in some Disco Cater code — kept for back-compat
   *  reads only. New code should use `count`. */
  quantity?: number
  /** Per-modifier flat price. NOT delta-from-base. FM: `price`. */
  price?: number
}

export interface OrderLineItem {
  name?: string
  /** Quantity ordered. FM: `count`. */
  count?: number
  /** Legacy alias kept for back-compat only. */
  quantity?: number
  /** Base meal-package price. FM: `price` (number, USD). */
  price?: number
  /** FM modifier array. NOT `extraItems` — `extraItems` is a Disco-Cater-
   *  only legacy alias from an earlier mis-typing. Read both for safety;
   *  the FM source always emits `orderAddOns`. */
  orderAddOns?: OrderLineModifier[]
  extraItems?: OrderLineModifier[]
}

/** Reads the line's quantity, preferring FM's `count` and falling back to
 *  the legacy `quantity` alias. Defaults to 1 (FM behavior: a meal package
 *  with no count field is treated as one). */
export function lineQty(item: OrderLineItem): number {
  return item.count ?? item.quantity ?? 1
}

/** Reads the modifier's quantity the same way. */
export function modifierQty(mod: OrderLineModifier): number {
  return mod.count ?? mod.quantity ?? 1
}

/** Returns the modifier array, preferring FM's `orderAddOns` and falling
 *  back to the legacy `extraItems`. Always returns an array (never undef). */
export function lineModifiers(item: OrderLineItem): OrderLineModifier[] {
  return item.orderAddOns ?? item.extraItems ?? []
}

/** Per FM `shared/order-details/order-details.component.html:284` —
 *  meal line displays `meal.price * meal.count`. Modifiers are NOT
 *  rolled into this; they render as sub-rows below with their own
 *  per-modifier totals. */
export function lineRowTotal(item: OrderLineItem): number {
  return (item.price ?? 0) * lineQty(item)
}

/** Per FM `...order-details.component.html:290` — each modifier row
 *  displays `addOn.price * addOn.count`. */
export function modifierRowTotal(mod: OrderLineModifier): number {
  return (mod.price ?? 0) * modifierQty(mod)
}

/** Sum of base × qty + all modifier totals. Used when an aggregate
 *  is needed (e.g. cart subtotal). FM doesn't display this per-line on
 *  the order-detail screen, but it's the math that reconciles to the
 *  order subtotal. */
export function lineGrandTotal(item: OrderLineItem): number {
  return lineRowTotal(item) + lineModifiers(item).reduce((s, m) => s + modifierRowTotal(m), 0)
}

/** USD currency formatter. FM uses Angular's CurrencyPipe with the
 *  default `USD` locale — `$x.xx`. We mirror with Intl.NumberFormat. */
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
export function formatCurrency(n: number | undefined | null): string {
  return USD.format(n ?? 0)
}

// ─── Inline test cases (mental, not executable) ─────────────────────────────
// Pulled from FM order #27350018 at Westwoods BBQ (the bug-trigger order)
// and two synthetic cases.
//
// Case 1 — line with $0 base + multiple modifiers (the Westwoods shape):
//   item = { name: 'Burnt Ends', count: 1, price: 0, orderAddOns: [
//     { name: 'BBQ Sauce', count: 2, price: 5 },
//     { name: 'Sides',     count: 1, price: 8 },
//   ] }
//   lineRowTotal(item)     → 0 * 1 = $0.00       (FM displays $0.00)
//   modifierRowTotal(0)    → 5 * 2 = $10.00      (FM displays $10.00)
//   modifierRowTotal(1)    → 8 * 1 = $8.00       (FM displays $8.00)
//   lineGrandTotal(item)   → 0 + 10 + 8 = $18.00 (reconciles to subtotal)
//
// Case 2 — multi-qty line, no modifiers:
//   item = { name: 'Sandwich Pack (12pc)', count: 2, price: 150 }
//   lineRowTotal(item)     → 150 * 2 = $300.00
//   lineGrandTotal(item)   → $300.00
//
// Case 3 — single line with modifier price * qty:
//   item = { name: 'Salad', count: 1, price: 11, orderAddOns: [
//     { name: 'Chicken', count: 3, price: 4 },
//   ] }
//   lineRowTotal(item)     → 11 * 1 = $11.00
//   modifierRowTotal(0)    → 4 * 3 = $12.00
//   lineGrandTotal(item)   → 11 + 12 = $23.00
