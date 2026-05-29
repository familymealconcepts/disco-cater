# Checkout init 500 — diagnostic (audit only)

> Test Kitchen ref `c8322ff4-32dd-47bc-8515-3f0cffc34bbf`. Order attempted:
> Sat May 30 2026, 12:30 PM, Pudding, pickup.
> **No code changed in this session** — this ranks candidate causes with FM-source
> evidence and ships `scripts/diagnose-init-failure.ts` to capture the live data.

## Read this first — what we can and can't see
- `POST /public-api/v2/restaurants/{ref}/orders/init` validation runs in **FM's
  Java backend**, which is NOT in the Angular repo we have. We can only reason
  from (a) the request payload Disco sends, (b) the restaurant fields FM's
  frontend/API expose, and (c) errors we've already reproduced. The decisive
  artifact is **the FM response body** Peter will capture — match its message to
  the hypotheses below.
- **Already found + fixed this week:** the init/PUT 500'd on
  `tipsType: "DOLLAR"` — FM's `TipsType` enum is `CUSTOM | PERCENTAGE` only
  (commit `613664e`). If the captured body is *not* a TipsType deserialize
  error, it's one of the causes below. If it still says TipsType, the deploy
  hasn't shipped `613664e` yet.

## Payload Disco sends (for reference)
Full `ICheckoutPreview` DTO (lib/pricing/checkout.ts): `items[]` (with
`restaurant.reference`, `count`, `extraItems[]`), `mealPackages: []`,
`orderType: 'PICKUP'`, `orderDate: '30.05.2026'` (DD.MM.YYYY), `orderTime`,
`restaurantReference`, `tips`, `tipsType` (now CUSTOM/PERCENTAGE), `taxExempt`,
optional `couponCode`.

---

## Ranked hypotheses

### H1 — Stripe Connect: Test Kitchen has no connected destination account · **LIKELY**
- **Why:** FM orders are Stripe **destination charges** — the platform needs the
  restaurant's connected account to build the payment. A test restaurant often
  isn't Stripe-connected. If init builds the payment intent eagerly, a missing
  destination would throw → 500.
- **FM evidence:** `IRestaurantSimpleResponse.restaurantConnectToStripe: boolean`
  (`_system/_models/restaurant.model.ts:44`); connection probe `HEAD
  api/stripe/{reference}` (`_system/_services/stripe/stripe.service.ts:33`);
  payout routing `moneyFlow` FAMILY_MEAL|DIRECT (`restaurant.service.ts:323-324`).
  Online-ordering itself is gated on Stripe in Order Settings
  (`admin/order-settings/order-settings.component.ts:217,235`
  `checkStripeConnectedState`).
- **Test Kitchen value:** unknown — run the script (`HEAD api/stripe/{ref}` →
  200 connected / 404 not; `restaurantConnectToStripe` on the restaurant object).
- **Proves it:** response body mentions Stripe / destination / account / connect,
  OR the probe shows not-connected. **Disproves:** probe shows connected.
- **Compare:** run the script against a known-working live restaurant; if that
  one is connected and Test Kitchen isn't, this is it.

### H2 — Menu / display pricing invalid for Pudding · **POSSIBLE**
- **Why:** init computes a subtotal from the items by reference. If Pudding's
  price is null/0/non-numeric server-side, total computation can throw.
- **FM evidence:** `IMealPackageSimpleResponse.displayPrice?` and numeric `price`
  (`_system/_models/meal-packages/meal-package.model.ts:42`); `displayPrice`
  validator is permissive `^[0-9\w\W]+$` (basic-info-tab.component.ts:91), so a
  garbage `displayPrice` can slip through while `price` is the real number used.
- **Test Kitchen value:** unknown — script fetches
  `GET /public-api/restaurants/{ref}/mealPackages` and flags any package with
  missing/zero `price`.
- **Proves it:** body mentions price/amount/NumberFormat/null; or the package has
  no numeric price. **Disproves:** Pudding has a valid `price > 0`.

### H3 — Lead time / cutoff rejects Sat 5/30 12:30 · **POSSIBLE-LOW**
- **Why:** the menu's `scheduleOption.prepTime` (lead time, hours) + `cutOff`/
  `cutOffDate` may make 5/30 12:30 too soon, and init might re-validate the slot.
- **FM evidence:** `scheduleOption.prepTime`, `cutOff`, `cutOffType`, `cutOffDate`
  (menu-settings-v2.component.ts form). Date is sent DD.MM.YYYY (correct).
- **Test Kitchen value:** unknown — script reports each menu's `prepTime` /
  `cutOff*` so Peter can compare against the requested datetime and "now."
- **Proves it:** body mentions date/slot/availability/cutoff. **Disproves:**
  lead time is small (e.g. 0–24h) and 5/30 is comfortably in range.
- **Note:** the client scheduler (`lib/scheduling/cutoffs.ts`) should already gate
  the pickup date, so a too-soon date would usually be unselectable — hence LOW.

### H4 — Tax configuration missing · **UNLIKELY**
- **Why:** init returns `stateSalesTaxInPrice/localSalesTaxInPrice/
  otherSalesTaxInPrice`. A missing rate almost certainly defaults to 0, not a 500.
- **FM evidence:** `GET/PUT api/restaurants/taxRate` (`restaurant.service.ts`
  taxRate). No init dependency visible.
- **Test Kitchen value:** unknown — script probes the tax-rate endpoint
  (best-effort; it's normally JWT/selected-restaurant scoped).
- **Proves it:** body mentions tax/rate/NPE in tax calc. **Disproves:** most cases.

### H5 — Restaurant blocked / wrong type / online-ordering off · **UNLIKELY**
- **Why:** `blocked` controls **marketplace visibility**, not ordering init;
  `type` ORDERING vs MARKETPLACE; `onlineOrderingAllowed` toggles ordering.
  If online ordering is OFF, init could be refused (but usually 4xx, not 500).
- **FM evidence:** `IRestaurant.type: 'ORDERING'|'MARKETPLACE'`,
  `onlineOrderingAllowed` (`restaurant.model.ts:18,34`); block toggle
  `POST api/admin/restaurants/manage/block/{ref}`.
- **Test Kitchen value:** unknown — script reports `blocked`, `type`,
  `onlineOrderingAllowed`, `restaurantStatus`.
- **Proves it:** body mentions not-allowed/disabled/blocked. **Disproves:**
  blocked=false, type=ORDERING, onlineOrderingAllowed=true.

### H6 — Group / role gating on order creation · **VERY UNLIKELY**
- **Why:** no evidence any group/role config gates `public-api` order creation;
  init is a public endpoint (no auth). Listed for completeness.
- **Proves it:** body mentions permission/role/group (would be surprising on a
  public endpoint). **Disproves:** default.

---

## Recommended order of investigation tomorrow
1. **Capture the FM response body** (Network → the failing `POST …/orders/init`
   → Response). Match its message to H1–H6 — this usually decides it in one read.
2. Run `scripts/diagnose-init-failure.ts` against Test Kitchen **and** a known
   working restaurant; diff the two (esp. Stripe-connected + package pricing).
3. If the body is a deserialize/enum error on another field, that's the fix
   (same class of bug as the TipsType one).

## How to run the script
```
FM_AUTH=<raw FM admin JWT, no "Bearer "> \
  npx ts-node --skip-project scripts/diagnose-init-failure.ts c8322ff4-32dd-47bc-8515-3f0cffc34bbf
# compare:
FM_AUTH=… npx ts-node --skip-project scripts/diagnose-init-failure.ts <working-restaurant-ref>
```
