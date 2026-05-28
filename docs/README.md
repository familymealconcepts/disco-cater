# Disco Cater — Engineering Docs Index

This folder is the **source-of-truth audit trail** for Disco Cater's migration off the FamilyMeal (FM) Angular frontend. Each doc is a from-FM-source audit of one surface, written before (and alongside) the code that mirrors it. The governing rule across every doc and every commit:

> **Mirror FamilyMeal exactly. Zero changes to FM backend. Read FM source before every fix. Match field names, endpoints, and flows exactly. If FM source is ambiguous, flag `[NEEDS REVIEW]` — never guess.**

FM Angular source lives at `/Users/peterventi/Desktop/familymeal-backend/src/app/`.

---

## How to use these docs (for future Claude Code sessions)

1. **Find the relevant audit doc below** for the surface you're touching. Read it first.
2. If no audit exists for your surface, **write one** (read FM source, cite `file:line`) before writing code.
3. **Match FM exactly** — field names, endpoint URLs, request/response shapes, order of operations, rounding. Don't "improve" FM's model.
4. **Commit per piece** with the FM `file:line` citation in the message.
5. If FM source can't answer a question, add it to the doc's "Open questions" and **skip** that piece — don't guess, especially on payments or access control.
6. The recurring gotchas (below) are already proven — don't re-derive them.

---

## Audit docs — categorized index

### Restaurant portal (ADMIN / SYSTEM_ADMIN)
| Doc | Covers | Status |
|---|---|---|
| [fm-restaurant-portal-audit.md](fm-restaurant-portal-audit.md) | The full restaurant portal: auth, sidebar, dashboard, orders, manage-menus, order-settings, groups, modifiers. The foundational 1,500-line audit. | current |
| [fm-authorized-users-audit.md](fm-authorized-users-audit.md) | SYSTEM_ADMIN "Authorized Users" page — list/create/edit/delete team members, the JWT-scoped location picker, role gating. Surfaced the existing `REGIONAL_ADMIN` role. | current (built) |
| [fm-multi-location-runtime-audit.md](fm-multi-location-runtime-audit.md) | SYSTEM_ADMIN multi-location Orders + Reporting aggregation (Tracks 1+2). FM aggregates by default via `/api/system-admin/orders` + `/api/system-admin/dashboard/sale/stats`. | current (partial — see doc) |

### Admin portal (SUPER_ADMIN)
| Doc | Covers | Status |
|---|---|---|
| [fm-admin-portal-audit.md](fm-admin-portal-audit.md) | The SUPER_ADMIN admin portal: dashboard, orders, content management, users, customers, system admins, restaurants (ordering/marketplace), bulk import, menus, banking/settings stubs. | current |
| [fm-super-admin-audit.md](fm-super-admin-audit.md) | Gap analysis of admin portal vs Disco Cater build. Tracks what's built/diverging/missing. Build-order recommendations. | current |
| [fm-marketplace-and-access-audit.md](fm-marketplace-and-access-audit.md) | Marketplace visibility model + SYSTEM_ADMIN access control. **Key finding: FM has no separate `marketplace` boolean** — only `type` enum + `blocked`. | current |

### Customer ordering + pricing
| Doc | Covers | Status |
|---|---|---|
| [fm-pricing-reconciliation.md](fm-pricing-reconciliation.md) | Order line-item display math. Fixed the Westwoods BBQ per-line bug; introduced `lib/pricing/lineItem.ts`. | current |
| [fm-cart-checkout-reconciliation.md](fm-cart-checkout-reconciliation.md) | Cart math, checkout POST payload shape, order-total order-of-operations, per-menu vs per-restaurant fee config. Q1 (addon.count scaling) resolved. | current |
| [fm-stripe-card-storage-audit.md](fm-stripe-card-storage-audit.md) | Diner saved-card flow. **Fixed the `token` vs `cardToken` field-name bug.** FM is single-card (`/api/users/payment/defaultSource`), legacy `createToken`, no SetupIntent. | current (built) |

### Planning / scope
| Doc | Covers | Status |
|---|---|---|
| [project-orca-scope.md](project-orca-scope.md) | Project Orca feature scope: Regional Admin, Global Menu Mgmt, Order Editing, Subscriptions, advanced Reporting. Some partially shipped in FM (`REGIONAL_ADMIN` exists). | current |
| [missing-restaurant-diagnosis.md](missing-restaurant-diagnosis.md) | Diagnosis of why "Test Restaurant" didn't appear in the SUPER_ADMIN dropdown. Superseded by the marketplace audit's `blocked`/`type` finding + the `/restaurants/[slug]` FM fallback. | partial / superseded |

### Revyrie tickets (hand-off specs for FM backend work)
| Doc | Covers |
|---|---|
| [revyrie-tickets/marketplace-visibility-toggle.md](revyrie-tickets/marketplace-visibility-toggle.md) | Spec to add a `marketplaceVisible` boolean to FM's restaurant model (hide from map without blocking direct URL). |
| [revyrie-tickets/super-admin-impersonation.md](revyrie-tickets/super-admin-impersonation.md) | Spec for audit-logged SUPER_ADMIN "View as SYSTEM_ADMIN" impersonation. |

---

## Recurring gotchas (proven across sessions — do not re-derive)

1. **Raw JWT, no Bearer.** FM expects `Authorization: <token>`, never `Authorization: Bearer <token>`. All proxy helpers (`lib/restaurant-auth.ts`, `lib/admin-auth.ts`, `lib/auth.ts`) return the raw token. A Bearer prefix produces opaque 401s.

2. **Pagination shape.** Query: `page` (0-based, omit when 0), `size` (25/50/100/250), `sort` (repeated key per entry). Response: `{ content, totalElements, totalPages }`. No cursors — page-based only.

3. **Restaurant type asymmetry.** `type: 'ORDERING' | 'MARKETPLACE'` is set at creation and **immutable**. Two separate admin lists (`/api/admin/restaurants` vs `/api/admin/restaurants/marketplace`), two explore branches (`/public-api/restaurants/explore?type=`).

4. **`blocked` is the only visibility flag.** There is NO `marketplace`/`isPublished`/`hideFromMarketplace` boolean in FM today. `blocked` hides everywhere (map + direct URL + ordering). See the marketplace Revyrie ticket for the proposed fix.

5. **`extraItems` (write) vs `orderAddOns` (read).** FM accepts `extraItems` in the order-init/checkout POST body but emits `orderAddOns` on the order-detail GET response. Both refer to the same modifier array. Code both sides — don't normalize.

6. **`addon.count` is per-meal; FM scales it.** Confirmed via live test (Pudding ×1 = $191, ×2 = $382). The modifier `count` is per-meal-package; FM multiplies by `meal.count` server-side. Cart line total = `(meal.price + Σ addon.price × addon.count) × meal.count`. See `lib/pricing/cart.ts`.

7. **SUPER_ADMIN uses explicit `restaurantReference` param, not a cookie.** Unlike SYSTEM_ADMIN's `fm_selected_restaurant` cookie + `setCurrentRestaurant` session, the SUPER_ADMIN admin portal passes `restaurantReference` as an explicit query param where scoping is needed.

8. **SYSTEM_ADMIN endpoints auto-filter by JWT.** `/api/system-admin/orders` and `/api/system-admin/dashboard/sale/stats` return data aggregated across the SA's assigned locations with NO `restaurantReference` param. FM rejects cross-location grants server-side (verified via curl). The client never needs to send the location list — the JWT carries it.

9. **Saved cards: single-card, legacy token flow.** FM stores ONE card per diner (`GET/POST /api/users/payment/defaultSource`), uses `stripe.createToken()` (NOT SetupIntent/PaymentIntent), platform Stripe account (no `stripeAccount` param). POST body is `{ cardToken }`. No delete/set-default endpoints exist.

10. **Menu default = raw `menus[0]`.** FM's checkout picks `menus[0]` in API order with no client sort. The menu model has a backend `position` (admin `updatePosition`) but the public `/public-api/menu` response shape doesn't expose it in the Angular interface. See `fm-multi-location-runtime-audit.md` Track 3.

---

## Shared helpers introduced by these audits

- `lib/pricing/lineItem.ts` — line-item display math + currency formatting.
- `lib/pricing/cart.ts` — cart line/subtotal math (FM scaling).
- `lib/pricing/totals.ts` — service charge / tip / grand total.
- `lib/pricing/checkout.ts` — `buildCheckoutPayload` (FM POST shape).

All pricing UI routes through these — no inline arithmetic in components.

---

## Session log — 2026-05-27 autonomous multi-track

| Track | Status | Notes |
|---|---|---|
| 1 — SA aggregated Orders | ✅ shipped (`840c609`) | Additive proxy routing to `/api/system-admin/orders` + Restaurant column + banner. ADMIN/SA-selected untouched. Needs live verify of aggregated response shape. |
| 2 — SA aggregated Reporting | 📋 documented, not shipped | FM aggregates by default but the dashboard's working "pick a restaurant" gate would be a regression risk to remove blind on a previously-fragile page. Exact change spec'd in `fm-multi-location-runtime-audit.md`; needs live verify of the aggregate sale-stats endpoint. |
| 3 — Default menu (E.2) | ✅ verified correct | FM uses raw `menus[0]`; `position` isn't on the public response, so the `476ecd0` sort degrades to FM's exact behavior. No change. |
| 4 — Sticky category header | ✅ verified, no change | FM section headers are NOT sticky (only the tab bar is). Disco's current normal-flow headers already match FM. |
| 5 — Marketplace Revyrie ticket | ✅ shipped (`259c804`) | `revyrie-tickets/marketplace-visibility-toggle.md` |
| 6 — Impersonation Revyrie ticket | ✅ shipped (`259c804`) | `revyrie-tickets/super-admin-impersonation.md` |
| 7 — Docs index | ✅ shipped (`259c804`) | this file |

All 6 prerequisite/code docs read; recurring gotchas confirmed unchanged. Code tracks held to the additive-only / no-blind-regression bar given the no-test autonomous context. Two items (Track 1 shape, Track 2 go/no-go) flagged for Peter's live verification.
