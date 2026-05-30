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
1. **Editable contact fields at checkout.** FM pre-fills firstName/lastName/email/
   phone from the logged-in user but keeps them **editable** (customers order for
   others) — `checkout-customer-info.component.ts:195-204, 313-318`. Disco
   hardcodes `customer` from `authUser` with no editable UI.
2. **Order-ID display format.** FM shows a short `orderNumber`
   (`order-confirmed.component.html:14-15`); Disco shows the raw UUID `orderRef`
   (`ConfirmationClient.tsx:71, 84`). Show `orderNumber` instead.
3. ✅ **Stripe "Incomplete" on first test order — RESOLVED (`8d9c304`).** See
   "Recently resolved" below.

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
