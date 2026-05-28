# FM Pricing Reconciliation — line-item layer

> Scope of this turn: **line-item rendering only** (Step 1.1, 1.3, 3.2 of the spec). Order-level fees / tax / tip / service-charge math is correctly read from FM's response on the surfaces we render today — that path is NOT re-audited here. Menu Settings reconciliation (Step 5) and restaurant-fees reconciliation (Step 6) are out of scope for this session.
>
> The Westwoods BBQ bug (#27350018) is the trigger. Root cause and fix below.

---

## Section 1 — FM line-item math (source of truth)

### 1.1 Display formulas

FM's `shared/order-details/order-details.component.html` is the source of truth for the order detail drawer, the customer receipt, and the print-summary template. All three render line items identically:

- **Meal-package line row**: `meal.price * meal.count` (`order-details.component.html:284`)
- **Modifier sub-row, one per modifier**: `addOn.price * addOn.count` (`order-details.component.html:290`)

**Critical**: the meal line shows base × qty only. Modifiers are **not** rolled into the meal-line total — they render as their own indented sub-rows below, each with its own per-modifier total.

Example (FM): a $0 base meal with a $5 × 2 modifier and a $8 × 1 modifier displays as:

```
1  Burnt Ends            $0.00
   + (2) BBQ Sauce       $10.00
   + (1) Sides           $8.00
```

The subtotal at the bottom of the order is FM-server-computed (`order.subtotal` on the response). The frontend never recomputes it from the lines — it just displays whatever FM sends.

### 1.2 No server-computed line total

FM does NOT send a pre-computed `linePrice` / `lineTotal` per item. The frontend multiplies. Confirmed via `_system/_models/order/print-summary.model.ts:13-19` — the modifier shape is `{ name, count, price, salesCategory }` with no derived fields.

### 1.3 Modifier field names

The line item:

```ts
{
  name: string
  count: number          // qty
  price: number          // base USD
  orderAddOns: Modifier[]
  comment?: string
}
```

The modifier:

```ts
{
  name: string
  count: number          // qty WITHIN one line item
  price: number          // per-unit modifier price (flat, not delta)
  salesCategory: string
}
```

**Field names are `count` and `orderAddOns`. NOT `quantity` and `extraItems`.** The latter pair were Disco-Cater-only aliases from an earlier mis-typing — they never existed on the FM response.

### 1.4 Currency formatting

FM uses Angular's `CurrencyPipe` with default settings — `$x.xx` USD, locale-aware. We mirror with `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`.

---

## Section 2 — Disco Cater line-item surfaces inventory

### S.1 Restaurant portal — order detail drawer
**File**: `app/(restaurant)/restaurant/(portal)/orders/page.tsx`
**Component**: `LineItemRow` (line 986 before fix, ~986 after)
**Status BEFORE this turn**: ❌ **financial-severity divergence**. Used `item.quantity` (always undefined → `?? 1`) and `item.extraItems` (always undefined → modifiers never rendered). Displayed `price` (base only, no × qty).
**Status AFTER this turn**: ✅ matches FM. Renders `price × count` on the line row, `modifier.price × modifier.count` on each indented sub-row. Reads `count` / `orderAddOns` with fallback to legacy aliases.
**Commit**: see end of doc.

### S.2 Restaurant portal — print order document
**File**: `app/(restaurant)/restaurant/(portal)/_components/PrintOrderDocument.tsx`
**Status**: ✅ already correct as of the print rebuild in commit `3cca896`. Uses `count` / `orderAddOns` with `price × count` math. No change needed.

### S.3 Customer portal — order detail panel
**File**: `app/(customer)/account/components/OrderDetailPanel.tsx`
**Component**: `LineItem` (line 399)
**Status**: ⚠️ **stylistic divergence** (not financial). Displays `${fmtMoney(price)}/pp` (per-person unit price) for both the line and each modifier. Does NOT show `price × count`. Renders qty as `(xN)` after the name when > 1.
**FM displays totals**; Disco Cater customer side displays per-unit pricing with a "/pp" suffix. The subtotal at the bottom (read from FM) is still correct, so no financial exposure — diners see correct totals — but the line-by-line display style is different from FM.
**Why I didn't change it**: this might be an intentional diner-UX choice (pricing transparency — "this is $11 per person"). Needs Peter's call before mirroring FM exactly. Flagged as open question.

### S.4 Customer portal — restaurant ordering page (`RestaurantClient.tsx`)
**File**: `app/(customer)/restaurants/[slug]/RestaurantClient.tsx`
**Status**: not re-audited this turn. This is the LIVE cart math, not an order-detail display — it composes a price the customer pays. The earlier session's fix (commit `4dcf7a1`) computed `effectivePrice = base + modifier sum` for the cart line; that diverges from FM's "base × qty + each modifier separately" model. **[NEEDS REVIEW]** in a follow-up session — see Section 4.

### S.5 Customer portal — checkout drawer
**File**: `app/(customer)/restaurants/[slug]/CheckoutDrawer.tsx`
**Status**: not re-audited this turn. Payload sends FM-shape `mealPackages[].{ extraItems: [...] }` per the comment in CLAUDE.md. Confirm field name matches FM's expected POST body shape on the order init / finalize endpoints — possible mismatch with FM's `orderAddOns` on the response side. **[NEEDS REVIEW]**.

### S.6 Subscriptions page — history rows
**File**: `app/(customer)/account/subscriptions/page.tsx`
**Status**: ✅ reads `order.total` directly off the FM history rows for display. No per-line math. No change.

### S.7 Admin portal — order detail
**File**: would be on `/admin/manage-orders` but currently no detail drawer is built (Section D.1 in the SA audit, deferred to its own session). When it ships, it must use the same helpers from `lib/pricing/lineItem.ts`.

---

## Section 3 — Shared helpers introduced this turn

**New file**: `lib/pricing/lineItem.ts`

Exports the five functions any future surface should route through:

- `lineQty(item)` — reads `count` with fallback to `quantity`, default 1
- `modifierQty(mod)` — same shape for modifiers
- `lineModifiers(item)` — reads `orderAddOns` with fallback to `extraItems`, always array
- `lineRowTotal(item)` — FM formula: `price × count`
- `modifierRowTotal(mod)` — FM formula: `price × count`
- `lineGrandTotal(item)` — base + all modifiers (aggregate, for reconciliation only)
- `formatCurrency(n)` — USD `$x.xx` via `Intl.NumberFormat`

Inline test cases at the bottom of the file cover the Westwoods $0-base-plus-modifiers shape, a multi-qty no-modifier shape, and a mixed shape. FM source citations are in the JSDoc.

---

## Section 4 — Out-of-scope surfaces (need follow-up sessions)

These are pricing surfaces I deliberately did NOT touch in this turn. Each needs its own focused session per the full spec.

### 4.1 Cart math on `RestaurantClient.tsx`
The customer ordering page builds a live cart with `effectivePrice = base + sum(modifier prices)` per line. This is the price the diner sees and pays. **It might diverge from FM's cart math** — FM's checkout flow uses `meal.price * meal.count + sum(addOn.price * addOn.count)` per line. Need to:
- Read FM's `cart.service.ts` / `pricing.service.ts` (Step 1.2 of the spec)
- Verify the order-init POST body shape FM expects (`extraItems` vs `orderAddOns` on the write side)
- Reconcile against the actual order-confirmation total
- Add cart-line tests

### 4.2 Customer order detail "/pp" display style
S.3 above. Possibly intentional. Peter to decide whether to align with FM's `× qty` totals or keep the per-person unit-price style.

### 4.3 Fees / tax / tip / service-charge breakdown math
`deriveTotals(o)` in the restaurant-portal orders page reads server-computed fields (`subtotal`, `stateSalesTaxInPrice + ...`, `tipsInPrice + ...`, `ownDeliveryFee + ...`). The TOTALS panel is correct because every number is server-truth. But the ORDER OF OPERATIONS (subtotal → discount → service charge → tax → tip → total) hasn't been verified against FM's `order-calculator.service` — Step 1.2 of the spec. Worth confirming before we ship any client-side reconciliation logic.

### 4.4 Menu Settings page reconciliation (Step 5)
Separate session.

### 4.5 Restaurant-level fees audit (Step 6)
Separate session.

### 4.6 Verification against 5 real orders (Step 4)
Cannot be done from here — requires browser + live FM data + Peter's access to the orders. The single Westwoods order #27350018 is the only concrete data point fed into the test cases in `lib/pricing/lineItem.ts`.

---

## Section 5 — Summary

- **Total line-item surfaces audited**: 7 (S.1–S.7).
- **Matched FM with no fix needed**: 3 (S.2 print doc, S.6 subscriptions list, and the totals panel on S.1).
- **Fixed**: 1 (S.1 `LineItemRow` in the restaurant-portal orders drawer).
- **Stylistic divergence, not fixed pending Peter's call**: 1 (S.3 customer-side `/pp` display).
- **Not audited this turn, flagged for follow-up**: 3 (S.4 cart math, S.5 checkout drawer, the broader fees/tax/service-charge order of operations).
- **New helpers**: `lib/pricing/lineItem.ts` with 7 exports + FM citations + inline test cases.

### Open questions for Peter

1. **S.3 customer order detail "/pp" style** — keep per-person unit pricing on the diner side, or mirror FM and show `price × count` line totals? FM's customer receipt shows totals, not per-person.
2. **Verification orders** — please run the Westwoods BBQ #27350018 once it deploys and confirm the line totals + modifiers match FM to the cent. If they do, we can confidently call S.1 done. If not, the fix needs another pass.
3. **Cart math reconciliation (S.4)** — separate session. Should I prioritize it before Menu Settings (Step 5) or after?
4. **Should the customer-side `LineItem` adopt the same `lib/pricing/lineItem.ts` helpers** even if we keep the `/pp` display style? (Wiring it through the helpers buys us field-name safety; the visual choice is independent.)

### Commit references

- `feat: lib/pricing/lineItem.ts shared helpers + drawer fix` — this turn's main commit.
- Earlier print doc (`3cca896`) already used the correct formulas; no change needed there.
