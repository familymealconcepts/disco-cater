# Native Menu Parity — Gap Analysis & Build Tracker

**Goal:** Disco-native restaurants (no FamilyMeal record) must have **every** feature and
tool the FM-backed menu system had this morning — rebuilt **entirely in Neon**. Disco-native
restaurants and their users (admin **and** customer) must **never** call, read from, or write
to FamilyMeal at any point. This is a hard constraint, not a nice-to-have.

**Method:** build stage by stage. Each stage = Neon migration → native API routes → admin/customer
UI → end-to-end test against Neon — fully done and verified before the next stage starts.

**Reference:** the FM-backed implementation (`manage-v2`, `manage/groups`, `manage/modifiers`,
`manage/bulk-pricing`, `manage/multi-unit-links`, `_MealPackageForm`, `RestaurantClient`) is the
spec for exactly how each feature should behave. We copy behavior, not the FM transport.

Status legend: ⬜ not started · 🟨 in progress · ✅ done & tested · ⏭️ intentionally skipped

---

## Scope decisions (approved by Peter)

1. ✅ In scope: cross-location SYSTEM_ADMIN tools (Bulk Menu Editor, Multi-Unit Links) — build to FM parity.
2. ✅ In scope: **all** restaurant-level settings (Closed Days, delivery time-window granularity,
   online-ordering toggle, tax, notifications) — full parity, not a subset.
3. ⏭️ Skip: item-level fields that were sent to FM but had **no UI** (per-item lead time, cutoff,
   max/day, inventory, day-select). Nobody could set these — nothing to preserve.
4. ✅ Audit the native customer checkout **first**, before building.
5. ✅ Modifiers & groups moved earliest (after the checkout audit) — biggest customer-visible gap.

---

## ⚠️ CRITICAL FINDING — Stage 0 audit (verified against the code)

The native customer path is **menu-display only**. The entire order lifecycle is still
FamilyMeal:
- `loadDiscoNativeRestaurant` (`app/(customer)/restaurants/[slug]/shared.tsx:315-368`) loads
  name/description/price/serves from Neon and emits a synthetic menu with **no settings, no
  schedule, no modifiers** (`:359-361`).
- **Every** `app/api/order/*` route proxies to FM (`init`, `update`, `validate-address`, `dates`,
  `times`, `place`, `stripe-info`) — verified. The only Neon touch is a saved-card *read* and a
  post-facto order *mirror* into `disco_orders`.
- **Payment is charged on FM's Stripe** — `confirm-payment/route.ts:14-17` says so and posts to
  `FM/api/userOrder/confirmPayment`. FM mints the PaymentIntent.
- The `isDiscoNative` flag exists only in `shared.tsx`; it is **not** threaded into
  `RestaurantClient`/`CheckoutDrawer`, so checkout always uses the FM proxies.

**Consequences:**
1. A disco-native restaurant (Neon UUID FM never saw) **cannot complete a real checkout** today —
   `/api/order/init` 404s against FM.
2. To the extent any checkout would proceed, it would **touch FM and charge on FM's Stripe** —
   a direct violation of the "never touch FM" constraint.
3. Therefore authoring settings/modifiers in Neon is necessary but **not sufficient** — a
   **native checkout backend** (init/price/availability/place/payment on Disco's own Stripe,
   reading Neon) is a prerequisite for any of it to "affect a real order."
4. This contradicts the `native-checkout-and-revyrie-gone` memory, which describes the *goal*;
   the customer flow has **not** actually been migrated off FM. Flagged for Peter.

**Awaiting Peter's re-sequencing decision** (native-checkout foundation vs authoring-first).

## Build order & progress

- **Stage 0 — Native checkout audit** ✅ done — see critical finding above
- **Stage 1 — NATIVE CHECKOUT FOUNDATION** ✅ COMPLETE & VERIFIED (1a–1h). Disco-native restaurants
  can take a real order end-to-end — menu → price → availability → address → place → pay (Disco's own
  Stripe) → complete → confirmations — with ZERO FamilyMeal contact (proven with FM pinned to a dead
  host). Next: Stage 2 (Modifier library), per the approved order.

---

## Stage 1 — Native Checkout Foundation (detailed plan; disco-native restaurants ONLY)

**Scope guard:** everything here is gated on `is_disco_native`. Existing FM restaurants keep the
FM checkout **untouched**. Fail-safe: if disco-native can't be confirmed, use the FM path (never
route an FM restaurant into the native path, and never route a native restaurant into FM).

**Already exists — REUSE (recon 2026-07-03), so this is mostly assembly + wiring:**
- `disco_orders` / `disco_order_items` / `disco_stripe_payments` — full schema incl. status
  lifecycle, tips, delivery, lead-gen (commission) columns (`lead_gen_one/two_disco_fee`).
- Cent-exact pricing libs: `lib/pricing/{cart,checkout,lineItem,totals}.ts` + `lib/promo-pricing.ts`.
- Stripe **webhook** already marks `disco_orders` DUE on `payment_intent.succeeded` and handles
  `payment_failed` / `charge.refunded` / `invoice.paid` (`app/api/stripe/webhook/route.ts`).
- Native destination-charge PaymentIntent pattern already used in order-edit
  (`app/api/restaurant/orders/[ref]/edit/route.ts:376`) — the template to reuse.
- Native delivery dispatch (`lib/expedite` — Dlivrd/Nash/Shipday, Neon-based).
- Restaurant Connect accounts (`disco_restaurant_accounts.stripe_account_id`) from onboarding.
- Confirmations pipeline (`lib/order-notifications.ts` `dispatchOrderConfirmations`).
- **Stripe platform account is settled**: the shared (formerly-FM) live account, permanent — no
  re-onboarding of Connect accounts.

**Genuinely NEW to build:**
- Native order-lifecycle API routes (parallel to the FM proxies), selected by `is_disco_native`.
- Native `order_number` generator (today it comes from FM).
- `loadDiscoNativeRestaurant` must emit a real `settings` + `scheduleOption` from Neon (starts
  minimal: item prices + tax; grows as Stage 5–7 settings land).
- Make `lib/pricing` the **server-side canonical** pricer for native orders (persist the breakdown).
- Native address/delivery validation (geocode via Mapbox/Google + radius) — no FM.
- Thread `isDiscoNative` from `shared.tsx` → `RestaurantClient` → `CheckoutDrawer`; native path uses
  Disco's Stripe publishable key + native endpoints (not FM `stripe-info`/`confirmPayment`).

**Sub-stages (built + tested one at a time, in order):**
- **1a — Pricing authority + schema.** ✅ DONE & TESTED (20/20). The cent-exact engine already
  existed (`lib/promo-pricing.ts` `computeBreakdown`, FM-verified) and `disco_sale_transactions`
  already has every breakdown column — so 1a added only the native-specific pieces:
  `lib/pricing/native-order.ts` (fulfillment routing + lead-gen resolver + config load) and three
  `disco_restaurant_overrides` columns (`lead_gen_one_pct` def 15, `lead_gen_two_pct` def 5,
  `withhold_payouts`). Tests: cent-exact vs FM worked example (224.08/168.06/158.59/5.17);
  routing (pickup keeps tip; self keeps tip+fee; third-party loses both → transfers 101.42/109.19/
  91.19); lead-gen first→repeat per (customer,restaurant), different customer still fee 1.
- **1b — Native menu-load settings/schedule.** ✅ DONE & TESTED (16/16).
  `lib/scheduling/native-schedule.ts` converts `disco_menus.schedule_config` (+ availability
  window) into the FM-shaped `scheduleOption` the client engine consumes; `loadDiscoNativeRestaurant`
  now loads the primary menu and emits `{ scheduleOption, settings:{menuAvailability:[PICKUP,DELIVERY]} }`
  (money/timing settings arrive Stage 5–7). Tested: weekday windows, slot boundaries (11:00→18:30),
  weekend exclusion, CUSTOM per-day, no-config fallback (all 7 days), endDate propagation; cutoffs
  self-tests still green.
- **1c — Native availability.** ✅ LARGELY DONE via 1b — availability is computed CLIENT-SIDE by
  `lib/scheduling/cutoffs.ts` from the emitted `scheduleOption` (zero FM calls). REMAINING: verify
  `RestaurantClient` date/time pickers use the client engine (not FM `/api/order/dates|times`) for
  disco-native, and that lead-time/cutoffs land once Stage 5 authoring exists. ⬜(verify in 1g)
- **1d — Native address/delivery validation.** ✅ DONE & TESTED (10/10). `lib/geocode.ts`
  (Mapbox-preferred forward geocoding + haversine) and `lib/order/native-delivery.ts`
  (geocode → distance → serviceability); `/api/order/validate-address` now branches on
  `is_disco_native` → native (zero FM), else FM proxy unchanged. Radius+fee are permissive/$0 until
  Stage 6 delivery-settings authoring. Tested: haversine (NYC→Philly ≈80mi), valid/invalid,
  client-coord passthrough, live Mapbox geocode.
  GEOCODING FIX (done): `place/route.ts` now also uses the shared Mapbox-preferred `lib/geocode`,
  so BOTH the native and FM-mirror paths geocode via a working provider (was: Google-only, silently
  null because the Geocoding API is disabled on the project). ACTION FOR PETER: enable the Google
  Geocoding API on the key's project to restore the Google fallback (not blocking — Mapbox works).
- **1e — Native order init/price/place.** ✅ DONE & TESTED (21/21). `lib/order/native-checkout.ts`:
  `priceNativeCheckout` (init — cart → cent-exact breakdown), `placeNativeOrder` (persist to
  `disco_orders` RESERVED + `disco_sale_transactions` INITIATED/DIRECT with the full breakdown),
  native `order_number` from new `disco_native_order_seq` (starts 900000000, never collides with FM).
  `/api/order/init` and `/api/order/place` now branch on `is_disco_native` (native → Neon, no FM
  JWT; FM path unchanged). Tested: cent-exact init, both-table persistence, unique numbers, and the
  RESERVED→DUE lead-gen lifecycle (fee 1 until a paid order exists, then fee 2).
  NOTE: native place currently trusts the body's customer identity — tighten to the disco_customer
  session in 1g/1h.
- **1f — Native payment.** ✅ DONE & EMPIRICALLY VERIFIED IN STRIPE TEST MODE (21/21, real charges).
  `lib/order/native-payment.ts` (destination-charge PaymentIntent + withhold handling +
  `getRestaurantPayoutConfig`) and `placeAndPayNativeOrder` (place → PI → link in
  `disco_stripe_payments` so the existing webhook flips RESERVED→DUE). `/api/order/place` native
  branch resolves the `disco_customer` session, maps the FM place body, and returns the PI
  `client_secret`. VERIFIED against real test-mode charges to the cent:
  · pickup $224.08 → restaurant $182.90 (Disco $41.18)
  · self-delivery ($8 fee+$10 tip) $242.08 → restaurant $200.38 (keeps both)
  · third-party ($8 fee+$10 tip) $242.08 → restaurant $182.38 (Disco keeps fee+tip, $59.70)
  · withhold → charge completes, NO transfer (funds held with Disco)
  · repeat customer → transfer +$19.10 (fee-1→fee-2 lead-gen delta)
  · place→PI→disco_stripe_payments link + transfer_data → connected account.
  REMAINING (client): CheckoutDrawer must confirm the returned `client_secret` with Stripe.js using
  the platform publishable key (browser UI) — paired with 1h E2E. Money flow itself is proven.
  (Historical note — the model was corrected from ground-truth extraction:
  the proven mechanism (test-16 + `promo-apply.ts`) is a **destination charge with
  `transfer_data.destination` = the restaurant's connected account and `transfer_data.amount` =
  restaurant payout (`Breakdown.transfer`)**, `on_behalf_of` = restaurant (keeps restaurant as MoR
  for tax/1099) — NOT `application_fee_amount`. Disco keeps `total − transfer` in the platform.
  Persist the full breakdown to `disco_sale_transactions`. Mirror `promo-apply.ts`'s
  cent-exact self-check (compute total+transfer, require integer-cent match to the PI) as the gate.
  Verify in Stripe **test mode** to the cent across pickup / self / third-party + a fee-1→fee-2 pair
  (per `payment-settlement-must-be-verified`). ⬜
- **1g — Client wiring (pricing).** ✅ DONE & TESTED (16/16). Instead of editing the money-critical
  CheckoutDrawer, the SERVER adapts to the existing client contract: `/api/order/init` and
  `/api/order/update` branch on `is_disco_native` → `priceNativeFmDto` prices the FM-shaped cart DTO
  in Neon and returns the SAME `data.checkoutPublicResponseDto` envelope the client already reads
  (`extractFmMoney`). Zero client changes; modifier lines + tips handled. Customer total is
  lead-gen-independent, so pricing needs no session.
  COUPLED TO 1f (place+pay): native `place` still reads the native contract (not the FM DTO) and the
  final charge needs the native PaymentIntent — so the place button wiring + FM-DTO adaptation of
  `place` + `disco_customer` session auth are done WITH 1f (they can't complete without the charge,
  and wiring place alone would allow half-placed unpaid orders). Native restaurants aren't live, so
  no interim risk.
- **1h — End-to-end.** ✅ DONE & VERIFIED (10/10 + client wiring). `CheckoutDrawer` gained a native
  branch: when place returns `{ native, clientSecret }` it confirms the platform PaymentIntent with
  Stripe.js (same account as FM) and lets the webhook complete the order — no FM confirm-payment.
  Full E2E against the real routes with FM pinned to a dead host (`127.0.0.1:9`): live native
  restaurant → menu renders → init prices $224.08 → place (customer session) → order RESERVED +
  client_secret → **real test card charges $224.08** → webhook completes (order DUE, sale txn PAID,
  payment SUCCEEDED) → confirmations dispatch runs. Server log shows **0** FM contact attempts.
  Follow-up (not blocking, native not live): native saved-card confirm; browser smoke-test of the
  Stripe.js confirm.

### 1f payment rules (CONFIRMED by Peter — must match FM exactly; verify empirically in Stripe test mode)

Model: destination charge to the restaurant's connected account; Disco's cut = `application_fee_amount`.
The restaurant's payout = total charged − everything Disco withholds. Withheld items:

| Item | Pickup | Self-delivery | Third-party delivery |
|---|---|---|---|
| Tip | restaurant keeps | restaurant keeps | **Disco keeps** (Disco pays courier) |
| Delivery fee | n/a | restaurant keeps 100% | **Disco keeps** (Disco pays Expedite/Dlivrd) |
| 3% convenience fee | Disco (withheld) | Disco (withheld) | Disco (withheld) |
| Stripe processing fee | withheld from payout | withheld from payout | withheld from payout |
| Lead-gen fee 1 or 2 | withheld from payout | withheld from payout | withheld from payout |

- **Convenience fee:** always 3%, paid by customer, always withheld → Disco. (Confirm base against code.)
- **Stripe fee:** withheld from the restaurant's payout — NOT billed separately to the restaurant.
- **Lead-gen fees:** fee **1** on the customer's FIRST order from a specific restaurant *location*;
  fee **2** on every order after that, forever, tied permanently to that customer↔location pair.
  Both withheld → Disco. (Need the customer↔location history lookup — match existing code.)
- **Withhold-payouts toggle (super admin):** must also work for disco-native restaurants — turning it
  on stops their payout exactly as it does for FM restaurants today. (Match the existing mechanism.)
- **Empirical gate:** 1f is NOT done until verified in Stripe **test mode** with real numbers — the
  restaurant payout and Disco's application fee reconcile to the cent for pickup, self-delivery, and
  third-party-delivery cases (incl. lead-gen fee-1-then-fee-2 across two orders by the same customer).

**Ground-truth extraction in progress:** reverse-engineering the exact FM money model already
implemented (promo/settlement/payout code) so the native pricer + Stripe params match to the cent —
NOT reconstructing from prose. 1a schema will hold the full breakdown (subtotal, tax, tip, delivery
fee, convenience fee, stripe fee, lead-gen fee, application-fee total, restaurant payout).
- **Stage 2 — Modifier library (Neon)** ✅ DONE & TESTED (14/14). `disco_modifiers` table +
  `/api/restaurant/disco-modifiers` CRUD (list/create/edit/archive/unarchive/clone/delete, SA
  location-scoped via resolveDiscoScopeRef) + native library UI at
  `/restaurant/menu-manager/modifiers` + nav link for Disco users. Zero FM.
- **Stage 3 — Group library + item attach (Neon)** ✅ DONE & TESTED (13/13).
  `disco_modifier_groups` + `disco_modifier_group_members` + `disco_item_groups`;
  `/api/restaurant/disco-modifier-groups` CRUD (membership, min/max rules, clone, cascade delete) +
  `/api/restaurant/disco-menu-items/[itemRef]/groups` (ordered attach + per-item enable); group
  library UI at `/restaurant/menu-manager/groups` + item-editor "Modifier Groups" attach section
  (checklist + per-group on/off) + nav link. Zero FM.
- **Stage 4 — Customer consumption of modifiers** ✅ DONE & TESTED (5/5). `loadDiscoNativeRestaurant`
  emits each item's enabled attached groups as `extraItemsGroups`; RestaurantClient renders the
  modifier modal and native pricing folds add-ons into the total ($12→$14 verified). Zero FM.
- **Stage 3 — Attach groups to items** ⬜
- **Stage 4 — Customer consumption of modifiers/groups (render + native pricing)** ⬜
- **Stage 5 — Menu money/timing settings** ✅ DONE & TESTED (7/7). disco_menus gained service
  charge (%+name), default tip, pickup/delivery order minimums, max orders/day, lead time, bookable
  window, daily + hard cutoff, fulfillment types. Stored via disco-menus create/edit; emitted by
  loadDiscoNativeRestaurant (settings + scheduleOption); service charge applied to the order total
  FROM THE MENU (client never dictates it) — verified $117.32 cent-exact. UI: "Order Settings"
  section in the menu form. Zero FM.
- **Stage 6 — Menu delivery settings** ✅ DONE & TESTED (6/6). disco_menus.delivery_settings JSONB
  (method own/third-party, own primary+secondary radius tiers with $/% fees, third-party subsidy %).
  Stored via disco-menus; validateNativeDelivery enforces the own-delivery radius + computes the fee
  (fixed or % of subtotal); place resolves fulfillment (own vs third-party) + fee authoritatively
  from the menu + distance (restaurant keeps own-delivery fee, Disco keeps third-party — per Stage 1f).
  Emitted FM-shaped to the customer page. UI: "Delivery" section in the menu form. Zero FM.
  Third-party delivery = FIXED platform fee (15% of subtotal capped at $85) that Disco always
  collects to pay the courier, SPLIT between customer + restaurant by the per-restaurant subsidy %
  (0–15) — matches FM's PriceCalculateService/RestaurantSaleTransactionServiceImpl EXACTLY:
    fullFee = min(subtotal×15%, $85);  customerFee = r2(fullFee×(15−subsidy)/15);  subsidy = fullFee−customerFee
  (`computeThirdPartyDelivery` in lib/menu-settings.ts). Customer pays customerFee; restaurant covers
  `subsidy` off its payout (computeBreakdown subtracts thirdPartyDeliverySubsiding from the transfer);
  Disco stays delivery-neutral. Threaded through validateNativeDelivery + the init preview + place +
  persistence. UI: subsidy input (0–15, default 0) in the menu form's Delivery section.
  Verified 25/25 incl. REAL Stripe test-mode PaymentIntents to the cent: $200 @ 5% → customer $20 /
  restaurant −$10 / Disco nets $30; $200 @ 0% → customer $30 / Disco nets $30. ✅ (subsidy restored per
  FM source, 2026-07-04.)
- **Stage 7 — Skipped days (menu) + Closed Days (restaurant)** ✅ DONE & TESTED (9/9).
  disco_menus.skipped_days JSONB (per-menu blackout ranges) + disco_restaurant_closed_days table
  (restaurant-wide) with `/api/restaurant/disco-closed-days` CRUD. Both merged into
  scheduleOption.skippedDays by loadDiscoNativeRestaurant → the availability engine excludes them.
  UI: "Blackout Dates" editor in the menu form. (Restaurant Closed-Days admin UI pairs with Stage 9
  restaurant settings; the API + consumption are done.) Zero FM.
- **Stage 8 — Item fields (display price, min qty, dietary, special instructions)** ✅ DONE & TESTED (6/6).
  disco_menu_items gains display_price, min_quantity, allow_special_instructions, vegetarian,
  contains_nuts, gluten_free, vegan. Stored via disco-menu-items create/edit; returned by the menu
  editor (categories GET); emitted by loadDiscoNativeRestaurant on each package. UI: fields in the
  item editor dialog. Zero FM.
- **Stage 9 — Restaurant-level settings** ✅ DONE & TESTED (5/5). `/api/restaurant/disco-settings`
  (GET/PUT over disco_restaurant_overrides): online-ordering toggle, delivery time-window
  granularity (new column), tax rates, notification emails/SMS + reminders. Native "Restaurant
  Settings" page (`/restaurant/menu-manager/settings`) incl. the Closed-Days admin UI; "Settings"
  nav repointed to it for Disco users. Tax set here flows into the order total ($112.88 verified).
  Zero FM. Online-ordering HARD GATE now wired (2026-07-04): `online_ordering_enabled` defaults ON
  (column default true + one-time backfill of the 9 existing native rows; go-live sets it true);
  `isNativeOrderingOpen` reads COALESCE(online_ordering_enabled, true); `/api/order/init` + `/place`
  reject a paused restaurant with 403 "not currently accepting online orders" (the checkout drawer
  surfaces it). Tested 5/5: open-by-default, paused blocks init+place before login/payment, re-enable clears it.
  Front-end polish (tested 7/7): loadDiscoNativeRestaurant emits `acceptingOrders` →
  restaurantSettings.onlineOrderingAllowed → RestaurantClient shows a "not currently accepting online
  orders" banner + disables/relabels the checkout CTA ("Not accepting online orders") so a customer
  sees it up front, not just at checkout.
- **Stage 10 — Location-level (fulfillment options offered)** ✅ COVERED BY STAGE 5. Disco-native
  restaurants have no separate FM location record — fulfillment types are menu-scoped
  (offers_pickup/offers_delivery, Stage 5); "shipping" = the NATIONWIDE_SHIPPING menu type. No
  separate location-level setting to build.
- **Small extras** ✅ DONE & TESTED (6/6). Per-menu "Include Utensils" toggle
  (disco_menus.include_utensils → stored, emitted to the customer page, menu-form toggle) +
  category visibility (disco-menu-categories PUT accepts `visible`; toggle in the category dialog;
  hidden categories drop off the customer menu — already filtered in loadDiscoNativeRestaurant).
- **Stage 11 — Small extras (utensils toggle, category visibility)** ⬜
- **Stage 12 — Bulk Menu Editor (SYSTEM_ADMIN, cross-location)** ✅ DONE & TESTED (13/13). This is a
  DISCO-built feature (`manage/bulk-pricing`), NOT an FM one (FM has no bulk price editor — its only
  "bulk" is a menu scraper). It was fully FM-backed: search hit FM's admin list + public menu
  endpoints, apply hit FM's mealPackages PUT, and the client's post-apply re-sync hit FM via
  `selected-restaurant`. Rebuilt native for disco sessions (FM path untouched): `bulk-pricing/search`
  fans out over disco_menu_items across the SA's group (getDiscoGroupAccounts); `bulk-pricing/apply-one`
  updates one disco_menu_items row (price/display/name/desc/serves) with a cross-group guard; and
  `selected-restaurant` now skips FM for disco sessions (cookie only). Tested 13/13 incl. cross-location
  search, single-location apply, group guard, and ZERO FM contact proven against a dead FM host.
- **Stage 13 — Multi-Unit Links (NATIVE, zero FM)** ✅ DONE & TESTED (17/17). Disco's link stack
  PROXIED FM (membership/slug-uniqueness/grouping in FM; Neon mirrored only slug/title/image) —
  unusable for disco-native locations. Rebuilt native for disco sessions (FM path untouched):
  - Neon store `lib/multi-unit-links.ts` — `disco_multi_unit_links` (slug unique-ci, title, owner) +
    `disco_multi_unit_link_members`; CRUD + `getNativeLinkBySlug`.
  - SA CRUD branches: `multi-unit-links` GET(list)/POST(create), `[ref]` PUT/DELETE (owner+group
    guard, slug regex + uniqueness), `group` returns {} (no FM Dashboard row), `live-count` counts
    live native members. Image reuses the slug-keyed disco_location_links mirror (Vercel Blob).
  - Customer `/locations/{slug}` (`lib/locations.ts`) resolves native first → members from
    disco_restaurant_cache (live only) → grouped by FULL state name (`lib/us-states.ts`) → native
    `/restaurants/{slug}` order links; falls back to FM for FM slugs. Single-location auto-redirect kept.
  Tested 17/17 incl. CRUD, slug-uniqueness/validation/guards, live-count, the customer page
  (state grouping, offline excluded, native order links), and ZERO FM contact vs a dead FM host.
- **Stage 14 — Consumption wiring for money/timing settings at order time** ⬜ (may fold into Stage 5–7)

---

## Full gap analysis (FM-backed vs native today)

### 1. MENU level
| Feature | FM (UI) | Native today | Verdict | Stage |
|---|---|---|---|---|
| Name, URL slug, image, visible | ✅ | ✅ (image via blob) | parity | — |
| Menu type/category (8 enums) | ✅ | ✅ | parity | — |
| Availability window (start/end date) | ✅ | ✅ | parity | — |
| Pickup/delivery time windows (per-day, same/custom) | ✅ `repeatWeekDays` | ✅ `schedule_config` | parity | — |
| Service type offered (pickup/delivery) | ✅ `menuAvailability` | ❌ | GAP | 5 |
| Delivery settings (method own/Nash, primary+secondary radius, fee $/%, subsidy %) | ✅ | ❌ | GAP (large) | 6 |
| Tips (10/15/20/custom) | ✅ `tipOption` | ❌ | GAP | 5 |
| Service charge (% + name) | ✅ | ❌ | GAP | 5 |
| Lead time (days+hours) | ✅ `prepTime` | ❌ | GAP | 5 |
| Bookable window (30/60/90) | ✅ `rollingAvailability` | ❌ | GAP | 5 |
| Daily cutoff (time) | ✅ `cutOff` | ❌ | GAP | 5 |
| Hard cutoff (date) | ✅ `cutOffDate` | ❌ | GAP | 5 |
| Order minimums (pickup $ / delivery $) | ✅ | ❌ | GAP | 5 |
| Max orders/day | ✅ `maxOrder` | ❌ | GAP | 5 |
| Skipped/blackout days (per-menu) | ✅ `skippedDays[]` | ❌ | GAP | 7 |
| Utensils toggle | ✅ (Neon side-store) | ❌ (no UI) | GAP (small) | 11 |
| Menu description | sent, no UI | column, no UI | skip | — |

### 2. CATEGORY level
| Feature | FM | Native | Verdict | Stage |
|---|---|---|---|---|
| Name, position/reorder | ✅ | ✅ | parity | — |
| Description | ❌ | ✅ | native ahead | — |
| Visibility toggle | ❌ | column only | optional | 11 |

### 3. ITEM level
| Feature | FM (UI) | Native today | Verdict | Stage |
|---|---|---|---|---|
| Name, description, price, serves, image, visible | ✅ | ✅ | parity | — |
| Clone, reorder, add-existing | ✅ | ✅ | parity | — |
| Display price (free text) | ✅ | ❌ | GAP | 8 |
| Min quantity | ✅ `minQuantity` | ❌ | GAP | 8 |
| Dietary tags (veg, nuts, GF, vegan) | ✅ | ❌ | GAP | 8 |
| Special-instructions toggle | ✅ | ❌ | GAP | 8 |
| Attached modifier groups | ✅ `extraItemsGroups` | ❌ | GAP (large) | 3 |
| Item lead/cutoff/max/inventory/day-select | sent, no UI | ❌ | ⏭️ skip | — |

### 4. GROUPS & MODIFIERS (cross-item libraries)
| Piece | FM | Native | Verdict | Stage |
|---|---|---|---|---|
| Modifier library (name+price; CRUD, archive, clone, paginate) | ✅ `/api/addOns` | ❌ | GAP | 1 |
| Group library (name, externalName, subExternalName, min/max, add-on membership; CRUD, archive, clone) | ✅ `/api/extraItemsGroups` | ❌ | GAP | 2 |
| Attach groups to items (ordered, per-item enable/disable, reorder, add-existing, inline add/edit) | ✅ | ❌ | GAP | 3 |
| Customer runtime (required-iff-min>0, min/max, per-option counts, $0-base + mandatory-group pricing, external labels, cart config) | ✅ | ❌ | GAP (critical) | 4 |

### 5. RESTAURANT level
| Feature | FM | Native | Verdict | Stage |
|---|---|---|---|---|
| Closed Days (restaurant-wide holidays/one-offs) | ✅ `/api/closedDays` | ❌ | GAP | 7 |
| Delivery time-window granularity (exact/30/60-min) | ✅ `feesAndTips` | ❌ | GAP | 9 |
| Online-ordering on/off | ✅ | verify | GAP | 9 |
| Tax rate | ✅ (mirrored to Neon) | partial | verify | 9 |
| Notifications | ✅ | verify | GAP | 9 |

### 6. LOCATION level & cross-location tools
| Feature | FM | Native | Verdict | Stage |
|---|---|---|---|---|
| Fulfillment options offered (pickup/delivery/shipping) | ✅ location dialog | verify | GAP | 10 |
| Bulk Menu Editor (SYSTEM_ADMIN cross-location) | ✅ | ❌ | GAP | 12 |
| Multi-Unit Links (shareable slugs) | ✅ (Neon-mirrored) | partial | GAP | 13 |

---

## Planned Neon schema (high level — refined per stage)
- `disco_modifiers` — reference, restaurant_reference, name, price, archived, visible, position, timestamps.
- `disco_modifier_groups` — reference, restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, archived, visible, position, timestamps.
- `disco_modifier_group_members` — group_reference, modifier_reference, position (many-to-many).
- `disco_item_groups` — item_reference, group_reference, enabled, position (attach + ordering).
- Menu settings: extend `disco_menus` / `disco_menu_settings` with delivery/tips/service-charge/cutoff/min-max/service-type columns.
- `disco_menu_skipped_days`, `disco_restaurant_closed_days`.
- Restaurant settings: extend `disco_restaurant_overrides` (or a settings table) for online-ordering, delivery-window granularity, notifications; tax already partially mirrored.

## Notes / open items
- Stage 0 audit output will be appended below and will confirm what the customer flow already reads from Neon and what must change.
- "Never touch FM" applies to the customer path too — modifier rendering & pricing must be Neon-sourced for disco-native restaurants.
