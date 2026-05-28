# FM Cart, Checkout, and Order Totals Reconciliation

> Companion to `docs/fm-pricing-reconciliation.md`. Scope: customer cart math, checkout POST payload, order total computation (steps 1.1–1.4 of the spec).
>
> **Status (updated)**: Q1 resolved — FM scales `addon.count` by `meal.count` server-side, confirmed by live Pudding × 1 → $191 / Pudding × 2 → $382 test orders. Our existing cart math and POST shape are correct. Centralized them through `lib/pricing/` helpers + added a `?debug=pricing` overlay + hardcoded test cases. See § 8.

---

## Section 1 — FM source audit

### 1.1 Cart line model

FM's cart line is `IMealPackageSimpleResponse` (`_system/_models/meal-packages/meal-package.model.ts:54-77`).

| Field | Type | Meaning |
|---|---|---|
| `reference` | string | meal-package UUID |
| `count` | number | meal-package qty |
| `price` | number | meal-package base price |
| `extraItems` | array | modifiers (on the WRITE side — see § 1.3) |

The modifier object inside `extraItems` carries:
- `reference` (modifier UUID)
- `name`, `price`, `count` (modifier-level qty)
- `extraItemsGroupReference` (parent group UUID — required by FM POST for nested groups)
- `type: "ADD_ON"` (literal enum, FM rejects POSTs that omit it)

Field-name asymmetry confirmed: **FM uses `extraItems` on POST/PUT (write) but emits `orderAddOns` on order-detail GET (read)**. Both names refer to the same array; FM rewrites the field name in the response. Our drawer fix from last session reads `orderAddOns` (correct). Our `CheckoutDrawer` writes `extraItems` (correct).

### 1.2 Cart line display math

FM's checkout sidebar template (`pages/public/checkout/checkout-sidebar-preview/checkout-sidebar-preview.component.html:34, 53`):

```html
{{ meal.price * meal.count | currency }}        <!-- line row -->
{{ addon.price * addon.count | currency }}      <!-- modifier sub-row -->
```

Same pattern as the order-detail drawer reconciled last session.

### 1.3 Order init / place POST shape

Endpoints (confirmed against `_system/_services/meal-packages/meal-package.service.ts:35, 196-210` and `CLAUDE.md`):

```
POST /public-api/v2/restaurants/{ref}/orders/init           → returns { orderReference }
PUT  /public-api/v2/restaurants/{ref}/orders/{orderRef}     → updates items + recomputes totals
POST /public-api/v2/restaurants/{ref}/orders/slotselected   → confirms time slot
POST /api/v2/restaurants/{ref}/orders/{orderRef}            → final place (auth required)
```

Body shape on `init`/PUT (per `_system/_models/checkout-preview.model.ts:6-33` and `pages/public/checkout/checkout-sidebar-preview/checkout-sidebar-preview.component.ts:829-837`):

```ts
{
  mealPackages: [
    {
      reference: string,            // meal-package UUID
      count: number,                // FM expects `count`, not `quantity`
      price: number,
      extraItems: [                 // FM expects `extraItems` on POST
        {
          reference: string,
          name: string,
          price: number,
          count: number,
          type: 'ADD_ON',           // literal — required
          extraItemsGroupReference: string,
        },
      ],
      comment?: string,
    },
  ],
  // ...delivery info, customer info, etc.
}
```

Our current `CheckoutDrawer.tsx:178-216` builds exactly this shape. **Field names + the `type: 'ADD_ON'` literal + `extraItemsGroupReference` all match.** ✅

**One wart**: our code sends `count` AND `quantity` on each meal-package line — the FM response model only has `count`. `quantity` is harmless if FM ignores unknown fields, but it's noise. Worth dropping in a future fix.

### 1.4 Order total computation

FM returns the canonical totals on the order PUT response (`pages/public/checkout/checkout-sidebar-preview/checkout-sidebar-preview.component.ts:714-738`):

```
subtotal, fee (= serviceCharge), discount,
stateSalesTaxInPrice, localSalesTaxInPrice, otherSalesTaxInPrice,
ownDeliveryFee, doordashDeliveryFee, thirdPartyDeliveryFee,
tipsInPrice, doordashTipsInPrice, thirdPartyDeliveryTipsInPrice,
serviceCharge, total
```

**Order of operations on display** (from `admin/manage-orders/print-summary/print-template/print-template.component.ts:337-402`):

1. Subtotal
2. Service charge (if present)
3. Taxes (state + local + other), shown as one "Taxes & Fees" line that also includes the `fee`
4. Delivery fee (if present)
5. Tip
6. Promo discount (if present, subtracted)
7. Total

**FM does NOT recompute these client-side after the PUT response** — it just displays the server values. This is why our restaurant-portal totals panel (already reading these same server fields) is correct.

`[NEEDS REVIEW]` — discount application order. Source shows it's subtracted at display, but whether it's applied before or after service-charge / tax computation isn't visible from the client templates. The server response carries already-applied numbers.

### 1.5 Per-menu vs per-restaurant fee config

| Setting | Level | Source |
|---|---|---|
| Service charge % | **per-menu** | `selectedMenu.settings.serviceCharge`, used by FM checkout sidebar |
| Service charge name | **per-menu** | `selectedMenu.settings.serviceChargeName` (checkout-sidebar-preview:568) |
| Tip presets | **per-menu** | `selectedMenu.settings.tipOption` |
| Pickup order minimum | **per-menu** | `selectedMenu.settings.pickupOrderMinimum` (line 1127) |
| Delivery order minimum | **per-menu** | `selectedMenu.settings.deliveryOrderMinimum` (line 1133) |
| Delivery radius | **per-menu** | `selectedMenu.settings.ownDeliveryRadius` |
| Own-delivery fee | **per-menu** | `selectedMenu.settings.ownDeliveryFee` |
| Third-party subsidy % | **per-menu** | `selectedMenu.settings.thirdPartyDeliverySubsidingPercent` |
| Tax rate | **platform** | Per the SUPER_ADMIN audit — no per-restaurant override |

**This is critical for the cart math reconciliation**: when our cart computes `serviceCharge = subtotal × svcPct`, the `svcPct` must come from the **menu** currently being ordered (not a restaurant-level setting). Multiple menus at the same restaurant can have different service charges.

### 1.6 Currency formatting

FM uses Angular's `CurrencyPipe` with default args (`{{ x | currency }}`) — USD, 2 decimals, locale-default. No custom rounding helper found. Per-value rounding at display, not per-line accumulation. Our `formatCurrency()` in `lib/pricing/lineItem.ts` already mirrors this with `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`.

---

## Section 2 — Disco Cater surface inventory

| Surface | File | Current shape | Match FM? | Severity |
|---|---|---|---|---|
| **S.4** Live cart subtotal | `RestaurantClient.tsx:491` `cart.reduce((s,i) => s + i.unitPrice * i.quantity, 0)` | Uses precomputed `unitPrice = base + Σ(modifier.price × modifier.count)` then × meal qty. | **⚠ ambiguous** — see § 6 q1 | financial if confirmed |
| **S.4b** Cart line display (sidebar) | `RestaurantClient.tsx:681-` | One row per cart line, displays `unitPrice × quantity` as "line total" and modifiers inline under the meal name. | Partial — display style differs from FM's split base / modifier rows | cosmetic |
| **S.4c** Cart subtotal display in cart sidebar | `RestaurantClient.tsx:710` | `formatPrice(subtotal)` | Matches FM's subtotal IF cart math matches | depends on S.4 |
| **S.4d** Client-side service-charge estimate | `RestaurantClient.tsx:494` `svcPct ? Math.round(subtotal * svcPct) / 100 : 0` | Multiplies subtotal × svcPct. `svcPct` source needs verification — should be `selectedMenu.settings.serviceCharge`. | **⚠ source-of-percent needs verification** | financial |
| **S.4e** Client-side tip estimate | `RestaurantClient.tsx:492` `Math.round(subtotal * activeTip) / 100` | Tip = subtotal × activeTip%. FM probably tips on `subtotal + serviceCharge` for some menus. `[NEEDS REVIEW]` | **⚠** | financial |
| **S.4f** Client total | `RestaurantClient.tsx:495` `subtotal + tipAmt + svcAmt` | **Missing tax, delivery fee.** This is an under-estimate — but the *server* total on PUT response is canonical. The client just shows a rough total before checkout submission. | partial | cosmetic-leaning |
| **S.5** Checkout payload | `CheckoutDrawer.tsx:190-216` | Builds `mealPackages: [{ reference, count, price, extraItems: [{ reference, name, price, count, type: 'ADD_ON', extraItemsGroupReference }], comment }]` | **✅ matches FM POST shape** | none |
| **S.5b** Extra `quantity` field on each mealPackage | `CheckoutDrawer.tsx:194` (per grep — `quantity` and `count` both sent) | Sends both `quantity` and `count`. FM only consumes `count`. | Cosmetic noise, not a bug | cosmetic |
| **S.3** Customer order detail display | `OrderDetailPanel.tsx:399-` `LineItem` component | Renders `$X/pp` per-person style; doesn't show `price × count` totals. | Diverges from FM display but intentionally per Peter's call | (do not change visual) |
| **S.1** Restaurant portal drawer | already reconciled commit `e9ed0dc` | ✅ | done |
| **S.2** Print order document | `PrintOrderDocument.tsx` | ✅ | done |
| Restaurant portal totals panel | `orders/page.tsx:deriveTotals` | Reads server fields directly | ✅ | done |

---

## Section 3 — `lib/pricing` extensions landed this turn

`lib/pricing/lineItem.ts` (extended this turn):

- Existing: `lineQty`, `modifierQty`, `lineModifiers`, `lineRowTotal`, `modifierRowTotal`, `lineGrandTotal`, `formatCurrency`.
- Added: `roundCurrency(n)` — FM's per-value 2-decimal rounding, used everywhere we display money.

Wiring landed this turn:

- **S.3** `OrderDetailPanel.tsx` `LineItem` now reads `count` / `orderAddOns` via the helpers. **`/pp` display style preserved per Peter's call** — only the field-name accessors changed, so the visual is identical. Buys field-name safety against future FM response renames.

### Helpers spec'd but NOT landed yet

These are documented in this section so the next session can add them with confidence; I'm not adding them on speculation when the underlying semantics are ambiguous (Section 6).

- `cartLineTotal(line)` — FM formula `price × count + Σ(addon.price × addon.count)`. **Depends on the addon-count semantics question** (q1).
- `cartSubtotal(lines)` — sum of `cartLineTotal` across lines.
- `computeServiceCharge(subtotal, svcPct)` — `subtotal × svcPct / 100`, rounded to cents per FM. Note: `svcPct` source = per-menu setting.
- `computeTip(base, tipPct)` — `[NEEDS REVIEW]` — base may be `subtotal` or `subtotal + serviceCharge`. Not certain from FM source.
- `computeDeliveryFee(...)` — FM computes server-side; the client just displays the response value.
- `computeGrandTotal(...)` — FM computes server-side on PUT.
- `buildCheckoutPayload(cart, customer, delivery, ...)` — would centralize the `CheckoutDrawer.tsx:178-216` mapping. Worth doing once the addon-count semantics question is resolved so the helper bakes the right convention in.

---

## Section 4 — Fixes landed this turn

| ID | Change | Commit |
|---|---|---|
| **S.3 wiring** | `OrderDetailPanel.tsx` `LineItem` now uses `lineQty`, `lineModifiers`, `modifierQty`, `formatCurrency` from `lib/pricing/lineItem.ts`. Display style unchanged (`/pp` preserved). | see git log this session |
| **roundCurrency helper** | Added to `lib/pricing/lineItem.ts`. Mirrors FM's per-value 2-decimal rounding. | same commit |

---

## Section 5 — Out-of-scope this turn (need Peter's call)

**Why these are deferred**: the current customer order flow works (orders submit, FM accepts the POST, customers complete checkout). The divergences below are correctness issues that would change cart math and/or checkout payload. Changing either could break working orders if my interpretation of FM's semantics is wrong. I'd rather flag them than guess.

1. **S.4 cart subtotal formula** — depends on Section 6 q1.
2. **S.4d service-charge `svcPct` source** — confirm it's reading from the currently-selected menu's `settings.serviceCharge`, not a default. `[NEEDS REVIEW]`.
3. **S.4e tip base** — `subtotal` or `subtotal + serviceCharge`? `[NEEDS REVIEW]`.
4. **S.4f client total breakdown** — should the cart preview show a full FM-style breakdown (subtotal / service / tax / delivery / tip / total) before checkout? Currently it shows `subtotal + tip + service`, omitting tax and delivery fee. Could be UX-by-design (the customer sees the full breakdown only after entering delivery info).
5. **S.5b drop `quantity` from checkout payload** — cosmetic noise, but should be cleaned.
6. **Debug overlay** (Step 5.2 of the spec) — `?debug=pricing` overlay showing cart line breakdown + POST payload preview. Worth adding once cart math is settled.

---

## Section 6 — Open questions for Peter

### Q1 — The addon-count semantics question (the big one)

When a diner orders 2 of a meal package, each with 1 "extra cheese" modifier, what does FM expect in the POST?

**Interpretation A — total count across the line**: `{ count: 2 (cheese count = meal qty × per-meal cheese), price: cheese_price }` for one cheese entry. Cart subtotal would be `meal × 2 + cheese × 2`.

**Interpretation B — per-meal count**: `{ count: 1 (one cheese on each meal), price: cheese_price }`. Cart subtotal would be `meal × 2 + cheese × 1 × 2`. FM's display formula `addon.price × addon.count` would show `cheese × 1`, which is the per-meal cost, not the line cost — confusing.

**What our code does today**: Sends `addOn.count` directly (per-meal). The cart subtotal formula `unitPrice × meal_qty` where `unitPrice = base + Σ(addon.price × addon.count)` multiplies modifier cost by meal qty — implicitly treating addon.count as per-meal.

**FM display formulas (`addon.price * addon.count`) and the existing code comment** ("FM scales it by the meal-package count server-side") contradict each other:
- The display formula treats addon.count as the absolute total.
- The comment claims FM multiplies server-side, implying addon.count is per-meal and FM scales it.

I cannot resolve this from FM source alone. Two ways forward:

- **Option 1**: Place a test order with `meal_qty=2, addon_qty=1`, check what FM's PUT response says the subtotal is. If it's `meal×2 + cheese×1`, addon.count is total. If `meal×2 + cheese×2`, addon.count is per-meal and FM scales.
- **Option 2**: Check FM's backend code (not the Angular client) for the order calculator's `calculateLineTotal` formula.

Until this is settled, **I won't change S.4 cart math or S.5 checkout payload**. The current code matches the comment-author's interpretation and orders flow through successfully — possibly the math is right and the display is just an approximation.

### Q2 — Tip base

Does the diner tip on `subtotal`, on `subtotal + serviceCharge`, or on `subtotal + serviceCharge + tax`? Different states / restaurants do this differently and FM's source doesn't make it visible client-side (the server returns the computed `tipsInPrice`).

### Q3 — Client total preview shape

Should the cart sidebar on `RestaurantClient.tsx` show a full FM-style breakdown (subtotal / service charge / tax / delivery / tip / grand total) BEFORE the diner reaches the delivery/checkout step, or is the current "subtotal + tip + service" preview good enough since FM's PUT response replaces it with the truth before payment?

### Q4 — Should the `OrderDetailPanel` display style switch to `× qty` totals?

Confirmed in last session that you want `/pp` style. Reconfirming because the helpers are now wired — flipping the display is a one-line change if you change your mind.

---

## Section 7 — Summary

- Total cart/checkout/totals surfaces audited: 11.
- Matched FM with no change needed: 4 (S.1, S.2, restaurant-portal totals panel, S.5 checkout POST shape).
- Fixed this turn: 1 (S.3 wiring through `lib/pricing` helpers, visual preserved).
- Deferred pending Peter's call (Q1): 4 (S.4, S.4d, S.4e, S.5b).
- New helpers added: `roundCurrency`.
- New helpers spec'd but not landed: 7 (Section 3).
- Test cases not added — depends on resolving Q1 before any cart-math tests are meaningful.

### Build-out plan for the next session (once Q1 is answered)

1. Add `cartLineTotal` + `cartSubtotal` to `lib/pricing/` with FM citations + tests.
2. Replace `unitPrice × quantity` subtotal in `RestaurantClient.tsx` with `cartSubtotal(cart.map(toFmLine))`.
3. Add `computeServiceCharge` + `computeTip` + `computeGrandTotal` helpers; wire the cart sidebar through them.
4. Add `buildCheckoutPayload` helper; replace the inline mapping in `CheckoutDrawer.tsx:178-216`.
5. Drop the redundant `quantity` field from the POST.
6. Add the `?debug=pricing` overlay.
7. Hardcode 5 verification orders as test cases.

---

## Section 8 — Q1 resolution + build-out completion

### Q1 resolved (2026-05-27)

**FM scales `addon.count` by `meal.count` server-side.** Confirmed by live test orders at Test Kitchen:

| Cart shape | FM-returned subtotal |
|---|---|
| Pudding × 1, TestModifier × 1 ($91) | **$191** (= 100 + 91×1×1) |
| Pudding × 2, TestModifier × 1 ($91) | **$382** (= 100 + 91×1×2 doubled = exactly 2×) |

Modifier display stays "(1)" on FM but the price multiplies in the line total behind the scenes. This means:

- Our existing cart subtotal (`unitPrice × meal_qty` with `unitPrice = base + Σ addon.price × addon.count`) was **already correct**.
- Our POST payload (sending per-meal `addon.count`, FM scales) was **already correct**.
- The "we charge too much in preview" concern flagged in earlier versions of this doc was wrong — flagged in error.

### Build-out — completed this turn

| Step | Status | Notes |
|---|---|---|
| 1. `lib/pricing/cart.ts` — `cartLineTotal`, `cartSubtotal`, plus `lineUnitPrice` | ✅ landed | Inline test cases include Pudding × 1, Pudding × 2, Westwoods $0-base, simple multi-qty, and a two-line aggregate. |
| 2. `RestaurantClient.tsx` cart subtotal wired through `cartSubtotal` | ✅ landed | Math is byte-equivalent to the previous inline reduce — visual unchanged. |
| 3. `lib/pricing/totals.ts` — `computeServiceCharge`, `computeTip`, `computeGrandTotal` | ✅ landed | Service charge is `subtotal × pct / 100` rounded; tip helper accepts pct or flat; grand total sums subtotal + service + tax + delivery + tip − discount. |
| 3a. RestaurantClient cart sidebar wired through totals helpers | ✅ landed | tipAmt, svcAmt, clientTotal all flow through helpers. |
| 4. `lib/pricing/checkout.ts` — `buildCheckoutPayload` | ✅ landed | Mirrors FM POST shape exactly (mealPackages[].extraItems[]{ type: 'ADD_ON', extraItemsGroupReference }). Inline test cases cover Pudding × 1, Pudding × 2, delivery-with-headcount. |
| 4a. `CheckoutDrawer.tsx` init body via `buildCheckoutPayload` | ✅ landed | Inline mealPackages mapping at line 192-208 replaced with one helper call. |
| 5. Drop redundant `quantity` field from POST | ⚠ kept | Helper still sends both `quantity` and `count` per the original code comment ("legacy v1 shim"). FM ignores unknown fields, so it's cosmetic noise. Worth dropping once we confirm no FM path reads `quantity`. **Deferred.** |
| 6. `?debug=pricing` overlay on checkout drawer | ✅ landed | Hidden unless URL has `?debug=pricing`. Shows each cart line's helper-computed total, a sanity check that the helper subtotal equals the prop subtotal (green tick / red MISMATCH), the service/tip estimates, and the full POST payload as JSON. |
| 7. Hardcoded 5 verification test cases | ✅ landed | Inline at the bottom of `cart.ts`, `totals.ts`, and `checkout.ts`. Cases: Pudding × 1, Pudding × 2, Westwoods burnt-ends-$0-base, simple multi-qty pickup, two-line aggregate. |

### What's still deferred

- **S.4f client total breakdown** — the cart sidebar still shows `subtotal + tip + service` only (no tax / delivery). The FM PUT response replaces this with the canonical total during the checkout flow, so the diner never sees a stale number at the payment step. Adding tax + delivery to the cart sidebar would require a pre-checkout PUT call to FM — not just helper wiring. Worth doing in a UX polish session, not here.
- **`quantity` field on POST** — see step 5 above. Cosmetic noise.
- **Customer-side `LineItem` display** — kept the `/pp` style per your earlier call.
- **Menu Settings reconciliation, restaurant-fees reconciliation** — separate sessions.

### Open questions for Peter

1. **`quantity` field on POST** — confirm FM never reads it, and we can drop it from `buildCheckoutPayload`. Currently sent alongside `count` for legacy safety.
2. **Tax / delivery on the cart-sidebar preview** — worth pre-PUTing the order to FM as the diner edits the cart so the preview shows a true grand total, or leave the current minimal preview since FM corrects it at checkout?
3. **Modifier display "scaled" clarity** — per your instructions, kept FM's current style (modifier row shows per-meal price even when meal qty > 1, so the line item display doesn't visibly reconcile). A future cosmetic session could show "× N meals = $X total" inline for clarity. **You said separate session — not touched here.**

### Where to verify

When this deploys, place a test order with `?debug=pricing` appended to the URL. The bottom-left overlay should:

- Show each cart line with the FM-style breakdown (`base × qty + Σ addons/meal × qty meals`).
- Show a **green ✓ subtotal matches** at the top if helper math agrees with the displayed cart subtotal.
- Show the full POST JSON that buildCheckoutPayload emits, so you can confirm field names + values before clicking Pay.
- Continue to render the same as before when `?debug=pricing` is NOT in the URL (it's gated; real diners never see it).
