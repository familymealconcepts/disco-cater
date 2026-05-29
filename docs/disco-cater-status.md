# Disco Cater — Status

> Last updated: 2026-05-29. Living status of the native ordering migration.
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
| Stripe card fields | `GET /stripe/platform/info` → tokenize | ✅ loads |
| **Place order** | `POST /api/v2/restaurants/{ref}/orders/{orderRef}` | ⛔ **CURRENT BLOCKER — untested** |
| Confirmation | `GET /api/userOrder/{orderRef}` | ⏳ not reached yet |

## ⛔ Current blocker — Place Order (untested)
Need to enter a **real Stripe test card** and click **Place Order** end-to-end.
This step (`confirmPayment` → `POST .../orders/{orderRef}` place) has not been
exercised yet. Watch for: Stripe tokenization, the auth'd place call (raw JWT,
no "Bearer"), and the confirmation fetch.

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
- Earlier fixes in this flow: `tipsType` enum CUSTOM|PERCENTAGE only (`613664e`);
  init reference read from `data.orderReference` (`6ed5b6b`).
