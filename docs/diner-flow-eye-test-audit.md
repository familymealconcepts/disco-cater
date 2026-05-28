# Diner Flow Eye-Test Audit

> Written 2026-05-27, triggered by the 100× tip bug. Hand-traced every displayed financial value across the diner flow and compared to FM. Severity: **financial** (affects what the customer sees they owe) / **functional** (wrong display, no money impact) / **cosmetic**.
>
> **Result: 1 financial bug found and fixed (tip). No other financial divergences.** Most diner surfaces read FM's server-computed totals directly, so they reconcile by construction.

---

## The bug that triggered this (FIXED)

**B.1 — Tip 100× off.** `RestaurantClient.tsx:503` passed `activeTip * 100` to `computeTip`, but `activeTip` is already in percentage points (presets `[10,15,20]`, custom `(dollars/subtotal)*100`, default `tipsPrice ?? 15`) and `computeTip` divides by 100 internally. So `$1 × 15%` → `1 × (15×100)/100` = `$15`. Fixed to pass `activeTip` directly. Commit `be732ad`. Regression test cases A–E added to `lib/pricing/totals.ts`.

This affected the cart tip display, the checkout drawer tip display, AND the FM payload (`tips: tipAmt, tipsType: 'DOLLAR'`) — all fed from the one computation.

---

## B.1 — `/restaurants/[slug]` (RestaurantClient.tsx)

| Value | Line | Formula | vs FM | Severity |
|---|---|---|---|---|
| Cart subtotal | 497-502 | `cartSubtotal(cart)` = Σ `(base + Σ addon.price×count) × meal.count` | matches FM scaling (confirmed live: Pudding ×2 = $382) | ✅ |
| Tip | 503 | `computeTip({ base: subtotal, pct: activeTip })` | **was 100× off — FIXED** | ✅ now |
| Service charge | 504-505 | `computeServiceCharge(subtotal, svcPct)` = `subtotal × svcPct/100`, `svcPct = settings.serviceCharge` (percentage points) | correct — passed directly, no double-scale | ✅ |
| Grand total estimate | 506 | `computeGrandTotal({ subtotal, serviceCharge, tip })` | correct (tax/delivery deferred — see B.2) | ✅ |
| Qty +/- controls | 552-556 | `incrementLine` maps delta then `.filter(i => i.quantity > 0)` | qty 0 removes the line ✓ | ✅ |
| Modifier aggregation | 585-609 | `extra += a.price × selectedQty`; `unitPrice = base + extra`; preview `(base + extra) × pkgQty` | matches FM | ✅ |
| Custom tip round-trip | 783 | `setTipPct((dollars/subtotal)*100)`, guarded `subtotal > 0` | $0.22 on $1 → pct 22 → $0.22 tip. No divide-by-zero. Correct after the tip fix | ✅ |
| "Serves N" labels | 700, 950, 1215 | renders `pkg.serves` directly | matches FM | ✅ |
| Date/time pickers | `computeDates`/`computeTimes` | derive from the menu's `scheduleOption` (repeatWeekDays, prepTime, rollingAvailability) | uses the active menu's window; spot-checked, not deeply re-traced this pass | functional — note below |

**Functional note (not fixed):** the date/time pickers compute availability client-side from `scheduleOption`. They appear correct against the menu schedule but a full reconciliation against FM's `availableTime` endpoint wasn't done this session — flagged for a scheduling-specific audit.

## B.2 — Checkout drawer (CheckoutDrawer.tsx)

| Value | Line | Formula | vs FM | Severity |
|---|---|---|---|---|
| Per-line total | 385 | `item.unitPrice × item.quantity` | matches cart scaling | ✅ |
| Subtotal | 393 | `subtotal` prop (cartSubtotal) | ✅ | |
| Delivery fee | 396-399 | PICKUP → "Free"; DELIVERY → "Calculated at checkout" | matches FM's deferred pattern | ✅ |
| Service fee | 401-405 | `svcAmt` prop | ✅ (fixed convention) | |
| Tip | 406-410 | `tipAmt` prop | ✅ now (was 100×) | |
| Tax | 412 | "Calculated at checkout" | matches FM | ✅ |
| **Estimated Total** | 415 | `subtotal + tipAmt + svcAmt` (omits tax + delivery) | **functional** | see below |
| Final total (payment step) | 469-470 | `fmTotals.total ?? … ?? subtotal + tipAmt + svcAmt` | uses FM server total once PUT returns | ✅ |
| Payload tip | 231 | `{ tips: tipAmt, tipsType: 'DOLLAR' }` | sends the corrected dollar tip | ✅ |

**Functional note (not fixed):** the "Estimated Total" on the review step is `subtotal + tip + service`, omitting tax and delivery (both labeled "Calculated at checkout", with a "+ delivery & tax" hint for delivery orders). This is intentional — FM also defers tax/delivery to the server PUT, and the payment step shows `fmTotals.total` (the real charge). Not a financial bug; the customer is never charged the estimate. Could optionally show the FM total earlier by pre-PUTing the draft, but that's a UX enhancement, not a correctness fix.

## B.3 — `/account/payment`
Audited + fixed separately this week (proxy 404 → null, Stripe Element mount). Not re-audited here.

## B.4 — `/account/orders`
`fmtMoney(o.total || o.totalAmount)` (line 162) — **server-computed total, displayed verbatim.** Date via `fmtDateLong`. No client arithmetic on money. ✅ No financial bug.

## B.5 — `/account/orders/[id]` (OrderDetailPanel.tsx)
`fmtMoney(detail.total)` (line 268) — server total. Line items use the `lib/pricing/lineItem` helpers; the `/pp` per-person display is intentional (Peter confirmed) and still renders (line 416). `counts` (line 112) is an item tally, not financial. ✅ No financial bug.

## B.6 — `/account/subscriptions`
`total = sub.totalAmount ?? sub.price` (line 391), `fmtMoney(total)` (line 485) — server values. Next-charge date from `sub.nextOrderDate` (line 449). History rows use `historyTotal(o)` = `o.total ?? o.totalAmount` (line 156). ✅ No financial bug. Pause/resume/cancel call FM status endpoints (no client math).

## B.7 — `/account/orders/history`
`fmtMoney(o.total || o.totalAmount)` (line 86) — server total. ✅ No financial bug.

## B.8 — `/account/addresses`
No financial values. Address form. (Form validation behavior is functional, out of scope for this financial pass.)

## B.9 — `/fullmap`
No price/`$` display on restaurant cards (name / location / image / cuisine only). Distance uses the standard Haversine formula (lines 29-33) for proximity sort. ✅ No financial display to diverge.

---

## Summary

| Severity | Count | Items |
|---|---|---|
| **Financial** | 1 (FIXED) | Tip 100× — `RestaurantClient.tsx:503`, commit `be732ad` |
| Functional | 2 (documented, not fixed) | Estimated Total omits tax/delivery (by design); date/time pickers not deeply reconciled vs FM `availableTime` |
| Cosmetic | 0 | — |

**Why only one financial bug:** the account pages (orders, history, subscriptions, order detail) all display FM's server-computed totals verbatim — there's no client-side money math to get wrong. The only place the diner sees client-computed money is the cart/checkout on `RestaurantClient` + `CheckoutDrawer`, and those route through `lib/pricing/` helpers. The tip was the one caller that double-scaled the percentage. Service charge, subtotal, modifier aggregation, and grand total were all already correct.

## Recommendations for a later (non-financial) pass
1. Reconcile the date/time picker availability against FM's `GET /public-api/menuReference/{ref}/availableTime?date=` rather than the client-side `computeTimes`.
2. Consider pre-PUTing the checkout draft so the review step shows the true FM total (incl. tax/delivery) instead of a partial estimate.
3. Address-form validation parity with FM (functional).
