# Native Checkout Initiative — Scoping Doc

**Status:** Scoping doc. Live checkout untouched, no code committed. **Framing: opportunistic, NOT an urgent migration** — FM's order/payment rail is stable and stays as-is; build only what ships safely alongside it (§ Step 3). Tax-rate backfill has since been **executed** (4,361 restaurants).
**Updated:** 2026-07-02 — full handoff PDF + `fm_backup.dump` inspected; reprioritized to lower-urgency per Peter; order-consolidation + Stripe-account decisions marked as settled/current state.

---

## 0. Headlines (read these first)

### ✅ Tax-rate backfill — EXECUTED (2026-07-02), full fleet covered.
`fm_backup.dump` → `familymeal.tbl_restaurants` had **`tax_rates varchar(500)`** (a JSON string) for **all 4,361 restaurants**, keyed by the same `reference` UUID Disco uses, in the **exact** shape the promo engine + Neon mirror consume:
```json
{"stateSalesTax":{"percent":8.875,"fixedAmount":null},
 "localSalesTax":{"percent":null,"fixedAmount":null},
 "otherSalesTax":{"percent":null,"fixedAmount":null,"types":["PICKUP","DELIVERY"]}}
```
- **All 4,361 parsed + upserted, 0 failures**, verified through the *actual* `lib/promo-apply.ts` extraction. 755 have a nonzero rate; the rest are null/0 (never-set → no tax, handled).
- Idempotent upsert with **`WHERE tax_rates IS NULL`** so **mirror-on-save always wins** (Test Kitchen kept its freshly-edited 5%, not the dump's 10%). Spot-check passed (see "Status of the no-Revyrie wins" below for the field-by-field result + freshness caveat).
- **Closed the mirror-on-save coverage gap for the entire fleet in one pass — no FM dependency.** Restaurant-funded promo codes now recompute discounted tax to the cent for all restaurants.

### ✅ Stripe account — FM's existing live account, kept PERMANENTLY (settled decision)
Disco operates on **FM's own Stripe account** using FM's live keys (`sk_live_51HyQsuKp5OWEZLTA…`, `pk_live_51HyQsuKp5OWEZLTA…`, Connect Client ID `ca_IZaR9OE2mbBAuNGFtNYa2E0zvJe1ZMMp` — account fragment `Kp5OWEZLTA` = where every promo-work PI settled). **Peter's decision: Disco keeps using this account indefinitely — this is deliberate and permanent, NOT a temporary state pending migration.** Consequences, now settled (no longer open questions):
- Existing restaurants' Connect accounts are already on the account Disco uses → **no per-restaurant Stripe re-onboarding, ever.** The "would restaurants need to reconnect" question is **answered: no.**
- Native PaymentIntent creation (if/when built) happens on **this same account** — the mechanism is already proven (promo test-16). Nothing about payments requires a new Stripe relationship.
- (Branding / Stripe display-name is being handled separately by Peter — out of scope here.)

### ✅ Order consolidation (FM → Disco unified dashboard) — ALREADY SHIPPED
Orders placed **through FM** (a restaurant's own 1P/direct FamilyMeal site) **already sync into Disco's Neon `disco_orders`**, so restaurants get **one unified order dashboard in Disco Cater today**. This is CURRENT, WORKING state — not a planned item.
- **Mechanism:** `lib/fm-orders-sync.ts` → `syncRestaurantOrders()` pulls FM orders into `disco_orders`, triggered by the **hourly cron `/api/cron/sync-fm-orders`** + an **inline sync on the restaurant orders-page load** (`app/api/restaurant/orders/route.ts`) + an admin manual sync (`/api/admin/sync/fm-orders`). The portal reads `disco_orders`, so both FM-origin and Disco-origin orders appear together.
- **One-directional by design:** the sync **skips `source_of_order='DISCO'` rows** — Disco-native orders are never pushed back into FM. Disco is the consolidation target; FM is not.

### ✅ `payment_intent.requires_action` (3DS/SCA) — MEASURED, LOW PRIORITY (Phase 1 cleanup)
FM has a `PaymentIntentRequiresActionEventHandler` (3DS/SCA), so it *can* occur; Disco doesn't handle it (FM's server-side `confirmPayment` returns `requires_action`, `CheckoutDrawer` treats non-`succeeded` as failure, no client-side next-action step, webhook doesn't handle it). **Live read-only diagnostic (90 days) settled the volume:**
- **7 of 2,065 PaymentIntents = 0.339%** hit `requires_action`; **all 7 are stale (>24h old); zero currently mid-flow.**
- **Verdict: NOT urgent — no immediate client-side 3DS fix needed.** Downgraded to a **Phase 1 webhook-parity cleanup item** (add the `requires_action` handler alongside `customer.*`; a client-side next-action step can ride along in Phase 1 but isn't blocking real payments today). US catering, as expected — negligible and self-abandoning.

### Webhook secrets cross-check
Disco's `STRIPE_WEBHOOK_SECRET` **differs** from FM's platform secret (`whsec_NTWqh2n2lj0RGe…`) → **Disco already has its own webhook endpoint** on the shared Stripe account (not riding FM's `api.familymeal.com` endpoint). Good — Disco doesn't need FM's secret; it needs its **own** endpoint subscribed to the full event set. The account-level secret + live key aren't exportable via `vercel pull`, so I couldn't byte-compare them, but the settlement-account evidence already confirms the key.

### Extra file in the folder
`FamilyMeal Meeting Agenda.pdf` (meeting notes, Jun 3 – Jul 1) — useful color: confirms the double-checkout duplicate-transaction bug (no idempotency in `placeCartOrder`, now guarded FM-side), the DISCO-order email suppression, order-edit work moved to prod, and that Revyrie added an `OrderPricingService` to centralize effective pricing. Nothing that changes the plan; folded where relevant.

---

## Step 1 — Inventory (updated with handoff facts)

| # | Touchpoint | Reality |
|---|---|---|
| 1 | **Order creation** | `POST /api/order/place` → FM `POST /public-api/v2/restaurants/{ref}/orders/{orderRef}`. FM returns `orderReference`, `orderNumber`, `checkoutPublicResponseDto` (full priced breakdown), and `paymentDetails.stripePaymentIntentDto.paymentIntentId`. FM order = `tbl_restaurant_orders`; payment state separate in `tbl_restaurant_sale_transactions`. **FM DB is schema-per-tenant** (each restaurant = its own `NNN_<uuid>` Postgres schema; master list in `familymeal.tbl_restaurants`). Order statuses: SELECTED→CART→RESERVED→(DUE for CARD / UNPAID→PAID for INVOICE)→COMPLETED. |
| 2 | **Payment** | FM creates the PI; confirm via FM `/api/userOrder/confirmPayment`. **CONFIRMED: Disco uses FM's live key on FM's Stripe account.** Payment finalization on FM side is a **custom JMS process engine** (`OrderAfterOrderPaymentFinalizedProcessDefinition…`), triggered by `payment_intent.succeeded` → `IntentSucceededEventHandler` → 9 steps (link payment, update connected acct, mark PAID/DUE, create delivery, emails, SMS, print, QuickBooks). CARD → DUE; INVOICE → PAID. |
| 3 | **Pricing/tax/fee engine** | **Already owned** in `lib/promo-pricing.ts`, cent-exact vs FM's `PriceCalculateService`. Not yet the source of truth at checkout. (Handoff notes FM added `OrderPricingService` to centralize effective pricing across voided/non-voided txns — worth mirroring the "effective pricing across all sale transactions" idea when Disco owns editing+pricing.) **Lead-gen fee 1→2 rule (CONFIRMED, for when Disco computes lead-gen itself in Phase 3/4):** the 1→2 transition is **PERMANENT per `(customer_email, restaurant)`** — **all-time** lookup (any prior *paid DISCO* order by that diner at that restaurant → fee-2 forever), **no reset, no rolling window**. Today's Path B does NOT replicate this (it *derives* the applied lead-gen % from FM's real transfer), so no code change is needed now — but the native-pricing implementation must use an all-time count, not a windowed one. |
| 4 | **Restaurant Stripe Connect** | **Existing restaurants: on FM's Stripe account** (which Disco already operates via FM's key) → usable directly, **no re-onboarding**. New partners: `lib/stripe-connect.ts` creates Express accounts (Disco's Connect Client ID). Post-connect redirect is frontend-controlled via `callbackUri` (no Stripe dashboard whitelist needed — confirmed in handoff). The `/registration`-makes-userless-account issue is a **permanent** FM constraint (no public `POST /api/restaurants` for a freshly-registered user). |
| 5 | **Webhooks** | Disco `/api/stripe/webhook` handles: `payment_intent.succeeded/​payment_failed`, `charge.refunded`, `invoice.paid/​payment_succeeded/​payment_failed`, `account.updated`, `payout.*`, `customer.subscription.*`. **FM processes 7 events:** `invoice.paid`, `payment_intent.succeeded`, **`payment_intent.requires_action`**, `payment_intent.payment_failed`, **`customer.created`**, **`customer.updated`**, `customer.deleted`. **Disco GAPS vs FM: `requires_action` (measured LOW priority — see §0), `customer.created/updated/deleted`** (associate Stripe customer↔user + default source). Disco has *extras* FM lacks (charge.refunded, invoice.payment_failed, account.updated, payout.*) — fine. Disco has its **own** endpoint+secret on the account. Note: FM verifies connected-secret first, platform-secret fallback (Disco already does the same dual-secret verification). |
| 6 | **Order editing** | **Already Disco-native** (`/api/restaurant/orders/[ref]/edit`, Neon, delta settlement; Test 15). FM also finished its own live-order-edit + edit-count enforcement (`OrderEditabilityEvaluator`) — but Disco's path is independent. |
| 7 | **Menu/item data** | Neon `disco_menus/categories/items` schema + manager UI exist (parked); customer ordering still reads FM's `mealPackages`. Cross-menu ordering + real `maxOrder` are blocked on making Neon the menu source of truth. |
| 8 | **Delivery** | **Already Disco-native**: `lib/expedite.ts` → Dlivrd directly; Disco holds `EXPEDITE_*`/`NASH_*`/`SHIPDAY_*`. Handoff: Dlivrd is primary; **Nash auto-converts to Dlivrd** (Nash kept for tracking history); DoorDash **disabled in prod**; Shipday for own-delivery; Dlivrd/Nash webhook signature verification is **disabled** in FM code. |
| 9 | **Tax rates** | **SOLVED by the dump** (§0). Mirror-on-save going forward + one-pass backfill = full fleet coverage. |
| 10 | **3rd-party integrations** | Disco already owns Twilio/Slack/Sentry/Nash/Shipday/Expedite. **QuickBooks: creds NOW provided in the handoff** (Client ID/Secret, OAuth redirect) — previously the one gap. **BUT** per-restaurant QuickBooks OAuth tokens live in the FM DB table `QuickBooksAccount` (in the dump) — Disco must either export those tokens or have restaurants **re-authorize** QuickBooks. ActiveMQ: not external (in-memory) — nothing to migrate. FM DB creds + `sk_live_`/`whsec_` values are all in the doc. |

---

## Step 2 — Feasibility categorization

- **ALREADY DISCO-NATIVE / SHIPPED:** pricing math, order editing, delivery dispatch, menu schema, new-partner Connect, Twilio/Slack/Sentry, own webhook endpoint, **FM→Neon order sync + unified order dashboard** (`fm-orders-sync`, one-directional), **tax-rate mirror + full-fleet backfill** (4,361 restaurants).
- **SOLVABLE FROM DUMP/DOC (no Revyrie):** tax-rate backfill (**verified, prepped**); QuickBooks token export (from `QuickBooksAccount` table) or re-auth; historical orders/customers; confirming the Stripe key/account (**done**).
- **STRAIGHTFORWARD TO MIGRATE:** Neon as menu source of truth; native order record into `disco_orders`; add the missing webhook handlers (`requires_action`, `customer.*`); client-side 3DS handling.
- **HARD:** native PaymentIntent creation owned end-to-end; QuickBooks payment-sync parity (FM's finalization does it in-process); staging + automated-test harness.
- **BLOCKED (permanent — Revyrie gone):** any FM-side change (public `POST /api/restaurants`, altered `/registration`, new endpoints); FM's JMS process-engine internals (reminders, subscription jobs, print jobs) must be **re-implemented Disco-side**, not extended. Treat FM as a frozen black box operable only via its existing API + its Stripe account (via the shared key).

---

## Step 3 — Phased plan — OPPORTUNISTIC, NOT AN URGENT MIGRATION

**Reprioritized framing (Peter's guidance):** FM's order-placement + PaymentIntent-creation endpoint is **stable and working today** and is **not** something to rush to replace. This is an **opportunistic** migration: keep building the pieces that can ship **safely alongside the current FM order rail** with no disruption risk (they add value on their own — pricing/menu ownership, consolidation already shipped); **do not** proceed with anything that would disrupt or replace the live order/payment flow without an explicit, separate go-ahead. Phases below are split accordingly.

### Safe to build now — alongside the FM rail, zero disruption to live orders
**Phase 0 — Foundations (no customer impact):** stand up **staging + Playwright/Vitest FIRST**; verify Disco's webhook endpoint receives the 7 FM event types.

**Phase 1 — Isolated cleanups:**
- **Tax-rate dump backfill** — ✅ **DONE** (4,361 restaurants; idempotent; mirror-on-save wins).
- **Webhook parity:** add `requires_action` + `customer.created/updated/deleted` handlers (measured low priority — 0.339%/90d, all stale). Additive/guarded; rollback trivial.

**Phase 2 — Neon menu source of truth (per-restaurant flag):** wire ordering to `disco_menus*` → unlocks cross-menu ordering + real `maxOrder`. **This is the main in-progress workstream.** Runs alongside FM's order rail (menu data only); rollback = flip to FM menu.

### HOLD — high-risk, replaces the stable order/payment rail (do NOT proceed without an explicit decision)
> These are **not scheduled**. They only become worth doing opportunistically, one restaurant at a time, behind a flag, with a warm FM fallback — and only when there's a concrete reason. Flagged high-risk because they touch live money/orders.

- **Phase 3 (HOLD) — Native order record:** create `disco_orders` using `lib/promo-pricing.ts` as the authoritative price instead of FM's `checkoutPublicResponseDto`, while still using FM's PI/settlement. Even keeping the FM Stripe rail, this changes what the customer is charged → **shadow-compare to the cent in staging before any live restaurant.**
- **Phase 4 (HOLD) — Native PaymentIntent creation:** Disco creates its own destination charge on the same FM Stripe account (mechanism proven, no re-onboarding). Highest stakes; requires re-implementing FM's in-process finalization Disco doesn't cover (QuickBooks sync, print jobs, reminders) + `requires_action` handling.
- **Phase 5 (HOLD) — Decommission FM proxying** per-restaurant after a long soak. Not a goal in itself; only if FM ever actually goes away.

**Rollback at every HOLD phase:** per-restaurant flag back to the FM order rail, which stays fully operational. Nothing here is one-way.

---

## Step 4 — Risks & open questions

**Stripe account — SETTLED (not an open question):**
- Disco runs on **FM's Stripe account, permanently, by deliberate choice.** Existing restaurants' Connect accounts are directly usable → **no re-consent, no fleet-wide re-onboarding — ever.** ✅ The earlier "would we need our own account / would restaurants reconnect" question is **closed: no.**
- **Merchant of record:** the restaurant remains MoR (`on_behalf_of`). Keep it that way if native PaymentIntent creation is ever built, to avoid Disco taking on sales-tax remittance / 1099 obligations — an MoR change would be finance/legal, not just engineering. (No such change is planned.)

**Permanent constraints (Revyrie gone):** no FM-side changes ever; FM's in-process finalization (QuickBooks, print, reminders, subscription generation/charge jobs) must be **rebuilt Disco-side** where Disco wants parity; QuickBooks continuity needs token export or re-auth.

**`requires_action`:** measured — 7/2,065 (0.339%) over 90d, all stale, none mid-flow. **Low priority**, folded into Phase 1 webhook parity; no urgent standalone fix.

**Testing:** stand up **Playwright/Vitest + staging BEFORE** any of the HOLD phases (native order record / native PaymentIntent) — those rewrite the money path. Phases 0–2 (foundations, cleanups, menu ownership) don't touch the money rail. The in-app `test-15/16` runner is good but manual/prod-adjacent.

**Remaining open questions (small — the big ones are settled):**
1. ~~`requires_action` volume~~ — ✅ measured (low).
2. ~~Long-term Stripe-account ownership~~ — ✅ settled (keep FM's account permanently).
3. QuickBooks: export `QuickBooksAccount` tokens vs. require re-auth (depends on how many restaurants use it — countable in the dump). Only relevant if/when a HOLD phase is ever pursued.

---

### Status of the no-Revyrie wins
1. **Tax-rate backfill — ✅ EXECUTED (2026-07-02).** All **4,361** restaurants' `tax_rates` imported into `disco_restaurant_overrides` from the dump; **0 parse/write failures**; spot-check passed (Test Kitchen structure identical, only its deliberately-edited state % differed; `fixedAmount` `null`≡`0` is tax-equivalent). **Idempotent + mirror-on-save wins** (only filled where `tax_rates IS NULL`).
   - **Freshness caveat (on record):** the imported values are the **2026-06-17 dump snapshot**, so a restaurant that changed its rate since then has a slightly stale value **until it next views/saves tax settings** (mirror-on-save overwrites it). This can **never mis-charge**: the checkout self-check recomputes FM's full-price total against FM's real PaymentIntent to the cent and, on any mismatch, **declines to apply the discount** rather than charge wrong. Backfill also created ~4,360 new overrides rows whose non-tax columns are benign defaults (no visibility/premium side effects).
2. ~~Measure `requires_action`~~ **DONE — 7/2,065 (0.339%) over 90d, all stale. Low priority → Phase 1 webhook-parity cleanup, no urgent 3DS fix.**
3. **Export QuickBooks tokens** from the dump's `QuickBooksAccount` table — only needed if a HOLD phase is ever pursued (not urgent; FM's rail stays).

---

## Future backlog (explicitly OUT of current scope — logged so they aren't lost)

- **Full-refund unwind (pre-order-date cancellation).** Its **own** scoping item — materially different from promo-code settlement because it touches a **fully-charged** order. When built, the refund must reverse **the customer charge + Disco's own take (3% convenience fee + lead-gen fee) back to the restaurant**, but **NOT the Stripe processing fee** (Stripe typically does not return the processing fee on a refund — **confirm against the actual Stripe account's agreement/settings when building**; a minority of processor agreements do refund it). Not a small add-on to anything currently in flight.
- **Disco-funded promo codes.** Confirmed on hold — no action. (The existing `/api/promo/redeem` plain-platform-refund path remains as-is.)
- **Stripe processing-fee rebate.** "Someday," not current scope (Peter researching typical structure separately).
- **100%-off restaurant-funded codes** are intentionally allowed (no discount ceiling — confirmed). ⚠️ Known checkout edge to handle when it arises: a 100%-off order that nets **$0** (no delivery/custom tip) can't be charged via Stripe (min-amount rule) — `applyRestaurantFundedDiscount` currently aborts on `newAmount <= 0`, so such an order would report "code couldn't be applied." True free-order handling (skip the charge entirely) is a small future item, not a blocker.

## PERMANENT CONSTRAINT — restaurant-funded promo codes are DIRECT-only (corrected 2026-07-02)
The earlier "FAMILY_MEAL is unblocked / money-flow-agnostic" claim from the promo work was **WRONG**. FM source + the dump confirm: for **FAMILY_MEAL** money-flow restaurants, **FamilyMeal itself is the merchant of record** — the PaymentIntent is a plain charge on FM's platform account (NO `on_behalf_of`, NO `transfer_data`), and the restaurant is paid **out-of-band via a DB-recorded `RestaurantPayment`** (FM's `sendNetPayoutToRestaurant` Stripe-transfer path is **commented out**), computed from FM's own **undiscounted** saleTransaction.
- Consequence: Path B (reducing the charge) would make **FamilyMeal's balance absorb the discount, not the restaurant.** There is no FM-side lever to reduce the out-of-band restaurant payout, and it **cannot be built** (Revyrie gone).
- Therefore **restaurant-funded promo codes are DIRECT-only, permanently — not a temporary gap.** Enforced at three layers (all live): **creation** (block FAMILY_MEAL locations), **validate** (decline for the customer), and **application** (`applyRestaurantFundedDiscount` bails via the `money_flow` mirror **and** a defensive check that the FM PI has no `transfer_data`). `money_flow` for all 4,361 restaurants is backfilled into `disco_restaurant_overrides` from the dump (30 FAMILY_MEAL).
- **Exposure at the time of the fix: ZERO** — no FAMILY_MEAL restaurant had ever used a restaurant-funded promo (0 restaurant-funded uses existed at all). No FamilyMeal absorption occurred; the bug was purely latent.
- FAMILY_MEAL restaurants (30) are rare, multi-location brands (Taim, Bagel Point, Point Lobster, Bird & Co., …).
