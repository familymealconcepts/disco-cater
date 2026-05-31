# Disco Cater — Status

> Last updated: 2026-05-30. Living status of the native ordering migration.
> (Created this session — there was no `disco-cater-status.md` before. The
> CLAUDE.md "Current State of Migration" section is the higher-level tracker.)

## Native ordering flow (package → date → time → address → payment → place)

| Step | Endpoint | Status |
|------|----------|--------|
| Browse menu | `GET /public-api/restaurants/{ref}/mealPackages` | ✅ working |
| Pick date | `GET /public-api/mealPackages/{ref}/availableDates` | ✅ working |
| Pick time | `GET /public-api/mealPackages/{ref}/availablePickUp` | ✅ working |
| Create draft (init) | `POST /public-api/v2/restaurants/{ref}/orders/init` | ✅ working — returns ref + pricing |
| Re-price (update) | `PUT  /public-api/v2/restaurants/{ref}/orders/{orderRef}` | ✅ working |
| Validate address | `POST /public-api/delivery/validate` | ✅ working (delivery) |
| Stripe card fields | `GET /stripe/platform/info` → tokenize | ✅ loads & mounts (`e60d827`) |
| Place order | `POST /api/v2/restaurants/{ref}/orders/{orderRef}` | ✅ sends full FM order object (`efc4e73`) |
| Charge card (confirm PaymentIntent) | `POST /api/userOrder/confirmPayment` | ✅ succeeded — card charged (`8d9c304`) |
| Confirmation | `GET /api/userOrder/{orderRef}` | ✅ reached |

## ✅ End-to-end checkout: working
First live order successfully placed and charged end-to-end on 2026-05-30
(Test Kitchen → Pudding → PICKUP → real test card). Final confirm response:
`paymentIntentStatus: succeeded`, `paymentIntentAmountReceived: 128`. No current
blocker on the native ordering flow.

## 📋 Next priorities
1. ✅ **Editable contact fields at checkout — RESOLVED (`f897f8f`).** First/last/
   email/phone are pre-filled from `authUser` and editable in the drawer; the
   place body's `customer` reads from those values, mirroring FM
   (`checkout-customer-info.component.ts:195-204, 313-318`).
2. ✅ **Order-ID display format — RESOLVED (`6cba9c4`+).** Confirmation page
   shows FM's short `orderNumber` instead of the UUID (falls back to the first
   8 chars of the UUID if FM doesn't return one).
3. ✅ **Stripe "Incomplete" on first test order — RESOLVED (`8d9c304`).** See
   "Recently resolved" below.
4. **In-drawer tip / quantity controls (future UX).** The re-pricing effect on
   `[tipAmt, cartKey]` is wired in `CheckoutDrawer.tsx` — a PUT will fire and
   FM will recompute tax/fees/total whenever those props change. But the tip
   pills (10/15/20/Other) and qty +/- buttons currently only exist in
   `RestaurantClient.tsx`'s Stage 1 cart panel; the drawer overlays Stage 1
   with a click-blocking backdrop, so today the diner has to close the drawer,
   change tip or qty, and reopen. A future pass should lift those controls
   into the drawer so they can be tweaked in-flight; the wiring is already
   there to receive the change.

## 📋 Group library — follow-ups (deferred)
Restored visibility this session — `manage/groups/page.tsx` was calling the
broken `/api/restaurant/groups` GET (forwarded to a non-existent FM list path)
instead of `/api/restaurant/groups/list`. Page + CRUD + clone proxies are wired;
the items below are nice-to-haves left for later:
1. **Reorder (drag-drop + position proxy).** FM exposes
   `PUT /api/extraItemsGroups/{ref}/position?position=N` (`groups.service.ts:42`)
   and the Angular UI has drag-drop. Disco has neither the proxy nor the UI.
2. **Archive workflow (PUT body merge).** `page.tsx:191-198` PUTs a *partial*
   body `{ archived, visible }`. FM's PUT replaces the full group, so this may
   silently fail or wipe other fields. Fetch the current group and PUT the
   merged body.
3. **`existing` endpoint for meal-package attachment.** FM
   `GET /api/restaurants/{ref}/extraItemsGroups/existing` (`groups.service.ts:88`)
   is what `manage-v2` would call when attaching an existing group to a meal
   package. No Disco proxy yet.
4. **Verify edit/clone/delete round-trip on live test** for the restaurant whose
   live order showed Coke + Cajun Blue Shrimp Sandwich.

## Manual tasks — owner action required
These need a browser login and can't be done from the repo / by the assistant.

- **Submit sitemap to Google Search Console.** The sitemap shipped in `4155b1f`
  but Google won't discover it until it's registered.
  1. Go to https://search.google.com/search-console
  2. Select the `discocater.com` property
  3. Sidebar → **Sitemaps** → **Submit new sitemap**
  4. Enter: `https://www.discocater.com/sitemap.xml`

  Re-submit any time `/new-york`, `/new-jersey`, `/los-angeles` (or other new
  static routes) are added back to `app/sitemap.ts` — they're omitted today
  because the pages don't exist yet and would 404 on crawl.

## Open notes (low priority, unverifiable from this repo)
- **Stripe description "DIRECT" vs "DISCO".** The "DIRECT" suffix on the charge
  is the restaurant's `moneyFlow` (payout routing; `restaurant.service.ts:323`),
  written server-side. Whether FM stamps `sourceoforder` ("DISCO") into the
  Stripe description is built in FM's Java backend (not in the Angular repo),
  so it's unverifiable from here. Revisit only if attribution reporting needs it.

## ✅ Recently resolved
- **`PUT /api/order/update` 500 (UNKNOWN_SERVER_ERROR) — RESOLVED (commit `6ecaad7`).**
  `runPricing` fired init then immediately PUT the re-price against the
  just-created order on the first run. FM's `checkoutPricesV2`
  (`meal-package.service.ts:311-355`) is an if/else — init the first time, PUT
  only on later changes; it never does both back-to-back. Fix: `runPricing` is
  now init-OR-PUT (first run inits and uses its returned pricing; later runs PUT
  only). Payload shape was never the cause — init/PUT bodies were identical and
  init accepted them. See [checkout-init-500-diagnostic.md](checkout-init-500-diagnostic.md)
  and [fm-cart-checkout-reconciliation.md](fm-cart-checkout-reconciliation.md).
- **Stripe "Incomplete" — RESOLVED (commit `8d9c304`).** Disco sent a raw card
  token to `confirmPayment` *before* placing the order and never created a
  PaymentMethod or confirmed the PaymentIntent, so the card was never charged
  (status "Payment method: None"). Now mirrors FM
  (`checkout-customer-info.component.ts:762-816`,
  `checkout-sidebar-preview.component.ts:1205-1252`): createToken →
  createPaymentMethod → place (FM mints the PaymentIntent) → confirmPayment with
  `{ orderReference, restaurantReference, paymentIntentId, confirmWithDefaultSource,
  paymentMethodId }` → require `paymentIntentStatus === 'succeeded'`. Stay on
  payment (no redirect) on any other status. Verified live 2026-05-30.
- **Place Order empty body → full FM order object (`efc4e73`)** and **Stripe
  Element teardown during Place Order (`e60d827`)**.
- Earlier fixes in this flow: `tipsType` enum CUSTOM|PERCENTAGE only (`613664e`);
  init reference read from `data.orderReference` (`6ed5b6b`).
