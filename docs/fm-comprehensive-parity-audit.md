# FM Comprehensive Parity Audit — All Three Login Types

> Read-only master audit, 2026-05-27. Single index across the diner, restaurant-portal, and admin-portal surfaces. Where a prior audit doc covers ground, this references it by name rather than duplicating. The four user-flagged priorities (per-menu Settings, lead-gen fees, third-party delivery withholding, fee logic) got the deepest fresh FM source reading and are the most detailed sections here.

---

# Section 0 — Methodology

- **In scope**: every route under `app/(customer)/`, `app/(restaurant)/`, `app/(admin)/`, plus cross-cutting concerns (fees, notifications, reporting, order lifecycle, permissions, scheduling).
- **Method**: for priority areas, read the FM Angular component + template + service and cite `file:line`. For already-audited areas, point to the existing doc and state current status without re-deriving.
- **Severity**: **financial** (affects money a customer/restaurant sees or is charged) > **functional** (wrong behavior/display, no direct money impact) > **cosmetic** (visual only).
- **Status values**: `matches` / `partial` / `missing` / `diverges`.
- **Relationship to prior docs** (all under `docs/`): this doc is the index. The detailed slices live in:
  - `fm-restaurant-portal-audit.md` — restaurant portal foundation
  - `fm-admin-portal-audit.md` + `fm-super-admin-audit.md` — admin portal
  - `fm-marketplace-and-access-audit.md` — visibility + SA access control
  - `fm-authorized-users-audit.md` — team members
  - `fm-stripe-card-storage-audit.md` — saved cards
  - `fm-pricing-reconciliation.md` + `fm-cart-checkout-reconciliation.md` — line-item + cart math
  - `fm-multi-location-runtime-audit.md` — SA aggregated orders/reporting
  - `diner-flow-eye-test-audit.md` — diner financial sweep
  - `project-orca-scope.md` — Regional Admin / Global Menu / Order Editing / Subscriptions / Reporting scope
  - `revyrie-tickets/*` — FM backend change requests

Recurring gotchas (proven; see `README.md` § gotchas) are not re-derived here.

---

# Section 1 — Diner (customer) login

Most diner financial surfaces were swept in `diner-flow-eye-test-audit.md` (1 financial bug found + fixed: the 100× tip). Status per route:

| Route | FM equivalent | Status | Notes / gaps |
|---|---|---|---|
| `/` homepage | `pages/public/home` | partial | Marketing page; not audited field-by-field. Cosmetic only. |
| `/fullmap` | `pages/public/explore` | partial | Sources from Sanity, not FM `explore?type=MARKETPLACE`. See `fm-marketplace-and-access-audit.md` § A.3 (deferred). No price display; Haversine distance correct. |
| `/restaurants/[slug]` (ordering) | `pages/public/checkout/checkout-pantry` | matches (post tip-fix) | Cart subtotal, tip (fixed), service charge, modifier aggregation all verified — `diner-flow-eye-test-audit.md` § B.1. FM slug fallback added (commit `bc91d3a`). |
| `/restaurants/[slug]` checkout drawer | `checkout-sidebar-preview` | matches/partial | Tip/svc correct; tax + delivery deferred to "Calculated at checkout" (matches FM). Estimated Total omits tax/delivery by design — `diner-flow-eye-test-audit.md` § B.2. |
| `/account/orders` | order history list | matches | Server totals verbatim. |
| `/account/orders/[id]` (detail panel) | order-history-details | matches | `/pp` display intentional; line items via `lib/pricing/lineItem`. |
| `/account/subscriptions` | subscriptions | matches | Server totals; pause/resume/cancel → FM status endpoints. |
| `/account/orders/history` | order-history | matches | Server totals. |
| `/account/profile` | profile | partial | Not field-reconciled this pass. Functional. |
| `/account/addresses` | account address | partial | Reads structured address from `/api/fm-user`. Form-validation parity not checked. Functional. |
| `/account/payment` | payment-card | matches (post-fix) | `cardToken` field fix + 404→null + Element mount fix shipped this week. `fm-stripe-card-storage-audit.md`. |
| `/account/notifications` | notification prefs | `[NEEDS REVIEW]` | Not reconciled against FM's notification model. Functional. |
| `/account/security` | password change | `[NEEDS REVIEW]` | Not reconciled. Functional. |
| `/account/favorites` | (FM has none — localStorage) | diverges-by-design | FM has no favorites endpoint; Disco uses per-user localStorage (`useFavorites`). Documented prior. |
| `/faq` | FAQ | matches | Static. |
| `/order-confirmation/[orderRef]` | confirmation | partial | Reads order detail; not deeply reconciled. |
| City pages (`/new-york`, `/los-angeles`, `/new-jersey`) | FM city landing | **missing** `[NEEDS REVIEW]` | No such routes found in `app/(customer)/`. Confirm whether FM has city landing pages and whether Disco needs them. |

**Section 1 gaps**: notifications + security reconciliation (functional); city pages missing (need confirmation they exist in FM); fullmap FM-sourcing deferred.

---

# Section 2 — Restaurant portal (SYSTEM_ADMIN + ADMIN)

Foundation in `fm-restaurant-portal-audit.md`. Per-route status:

| Route | Role | Status | Reference / gap |
|---|---|---|---|
| `/restaurant/login` | all | matches | Role routing fixed (`4c212ea`). |
| `/restaurant/dashboard` (Reporting) | SA + ADMIN | partial | Aggregate-by-default for SA documented but gated (`fm-multi-location-runtime-audit.md` Track 2 — held back, regression risk). |
| `/restaurant/manage/locations` | SA | matches | Row-click drilldown + edit. |
| `/restaurant/manage/authorized-users` | SA | matches | Shipped + verified (`fm-authorized-users-audit.md`). |
| `/restaurant/orders` | SA + ADMIN | matches (Track 1 shipped) | SA aggregated orders + Restaurant column (`840c609`). Order drawer: refund/void/complete/print/notes present. |
| `/restaurant/manage-v2/menus` (list) | SA + ADMIN | partial | List + tabs + Menu Settings pill present. Drag-reorder `[NEEDS REVIEW]` vs FM. |
| **`/restaurant/manage-v2/[menuRef]/settings` (per-menu Settings)** | SA + ADMIN | **DIVERGES — see § 2.A** | The big one. |
| `/restaurant/manage/groups` (Group Library) | SA + ADMIN | partial | Not reconciled this pass. |
| `/restaurant/manage/modifiers` (Modifier Library) | SA + ADMIN | partial | Not reconciled this pass. |
| `/restaurant/order-settings` (Settings) | SA + ADMIN | partial | Communication/scheduling/discounts built (`7c2b423`); not full field reconciliation. |
| `/restaurant/account/profile` | ADMIN | partial | Not reconciled. |
| `/restaurant/account/banking` (Stripe Connect) | ADMIN | partial | Connect flow present; not deeply reconciled. |
| `/restaurant/tax-rate` | SA | partial | Reads platform tax; per-restaurant override doesn't exist in FM. |
| `/restaurant/restaurant-customers` | SA + ADMIN | partial | Customer list; not reconciled. |
| `/restaurant/manage/admin-manager-reports` (Reports) | SA | partial | Not reconciled. |
| `/restaurant/manage/multi-unit-links` (Links) | SA | matches | `11039eb`. |

## 2.A — Per-menu Settings dialog (PRIORITY — full field-by-field)

**FM component**: `admin/manage-menus-v2/menus-v2/menu-settings-v2/menu-settings-v2.component.{ts,html}`. FormGroup at `menu-settings-v2.component.ts:150-202`. Service: `_system/_services/menu/menu.service.ts`.

**Endpoints**: `GET /api/menu/{ref}`, `PUT /api/menu/{ref}`, `POST /api/menu`, `PUT /api/menu/{ref}/visible?isVisible=`, `PUT /api/menu/{ref}/archive?isArchived=` (`menu.service.ts:40-64`).

**Disco Cater equivalent**: `app/(restaurant)/restaurant/(portal)/manage-v2/menus/MenuSettingsDialog.tsx`. The interface declares all fields, but the **rendered form only edits a subset**; the rest are spread-preserved from `menu.settings` on save (`MenuSettingsDialog.tsx:250-261`).

### Field-by-field reconciliation

| FM section / field | FM control → API field | FM source | Disco status |
|---|---|---|---|
| **Menu Details — name** | `menuName` → `name` | ts:224 | ✅ built |
| **Menu category** | `menuCategory` → `type`, enum: GENERAL_CATERING / OFFICE_CATERING / HOLIDAY_CATERING / MEAL_PREP / PRIVATE_CHEF / NATIONWIDE_SHIPPING / MERCH / POP_UP | fake-data.constant.ts:675-716 | **DIVERGES** — Disco `MENU_TYPES` uses FAMILY_MEAL/CATERING/KITS/BEVERAGES/… (`MenuSettingsDialog.tsx:60-61`). Wrong enum. Financial-adjacent (menu categorization drives marketplace placement). `[NEEDS REVIEW]` whether `type` (v2 category) and the legacy `menuType` are distinct fields. |
| **URL slug** | `url` → `url`, pattern `^[A-Za-z0-9-_]+$` | ts:226 | ✅ built |
| **Image** | file → `image.reference` (separate upload) | html:49 | partial — not built |
| **Menu Availability** | `menuAvailability` default/custom → `scheduleOption.startDate`/`endDate` | html:67-94 | partial |
| **Pickup Window** | `isSameDay` enabled/disabled → `scheduleType` SAME_DAY/CUSTOM; per-day `repeatWeekDays[]{days,fromPickUpTime,toPickUpTime}` | ts:1173-1207 | ✅ built (SAME_DAY/CUSTOM + day pills) |
| **Prep Time** | `prepDays`+`prepTime` → `scheduleOption.prepTime` = days×24+hours | ts:970 | ✅ built |
| **Order Cut-off** | `cutOffType` NO/DAILY/BY_DATE → `cutOff`,`cutOffDate`,`cutOffType` | html:283-327 | ✅ built |
| **Order Minimums** | `pickupOrderMinimum`,`deliveryOrderMinimum` → `settings.*` | html:337-347 | ✅ built |
| **Tips & Surcharges** | `tipSize`/`customTipSize` → `settings.tipOption{tipsPrice,tipsType}`; `serviceCharge`,`serviceChargeName` → `settings.*` | ts:1009-1012 | **partial/MISSING** — Disco preserves `tipOption`+`serviceCharge` but does NOT render editable tip presets or service-charge inputs in the dialog. Financial. |
| **Rolling Availability** | `rollingAvailability` 30/60/90 → `scheduleOption.rollingAvailability` | ts:61 | ✅ built |
| **Max Orders / 15-min** | `maxOrderVariant`+`maxOrder` → `scheduleOption.maxOrder` | ts:1025-1029 | ✅ built |
| **Pickup & Delivery Availability** | `menuAvailability[]` PICKUP/DELIVERY → `settings.menuAvailability` | html:458 | ✅ built |
| **Delivery type** | `deliveryType` enum **OWN_DELIVERY / NASH_DELIVERY** → `settings.deliveryType` | fake-data.constant.ts:802-813 | **DIVERGES** — Disco type uses `'OWN_DELIVERY' \| 'THIRD_PARTY'` (`MenuSettingsDialog.tsx:29`). FM's third-party value is `NASH_DELIVERY`, not `THIRD_PARTY`. Functional. AND the UI section isn't rendered (preserve-only). |
| **Self-delivery primary** | `ownDeliveryRadius`, `ownDeliveryFee` ($) OR `ownDeliveryFeePercent` (%) | html:475-510 | **MISSING UI** — fields in type, not editable. Financial (delivery pricing). |
| **Self-delivery secondary tier** | `secondaryOwnDeliveryRadius`, `secondaryOwnDeliveryFee`/`Percent` | html:511-537 | **MISSING UI**. Financial. |
| **Third-party withholding** ← user-flagged | `thirdPartyDeliverySubsidingPercent` → `settings.thirdPartyDeliverySubsidingPercent` (defaults to **20** if cleared; UI label "0-15%" but no validation) | html:538-548, ts:846-852 | **MISSING UI** — field in type, not editable. Financial — this is the platform/restaurant delivery-cost split. |
| **Menu Scheduling Override** | `skippedDays[]{name,fromDate,toDate,intervals[]{fromTime,toTime}}` via skipped-days modal | ts:1022-1023 | **MISSING UI** — field in type, not editable. Functional. |

**Full PUT payload shape** is captured in the agent dump (Menu Details `name`/`type`/`url` top-level; `scheduleOption{scheduleType,repeatWeekDays,startDate,endDate,prepTime,cutOff,cutOffType,cutOffDate,rollingAvailability,maxOrder,skippedDays}`; `settings{pickupOrderMinimum,deliveryOrderMinimum,tipOption,serviceCharge,serviceChargeName,menuAvailability,deliveryType,ownDelivery*,secondaryOwnDelivery*,thirdPartyDeliverySubsidingPercent}`).

**Summary of 2.A**: Disco's per-menu dialog correctly handles ~7 sections (details, pickup window, prep, cutoff, minimums, rolling, max orders, availability) but is **missing editable UI for the three most fee-relevant sections**: Tips & Surcharges, Delivery Fulfillment (primary/secondary self-delivery $/% + NASH third-party subsidy), and Scheduling Override — and has two **wrong enums** (menu category, deliveryType third-party value). This matches the user's flag precisely.

`[NEEDS REVIEW]` items from FM source: prep-time fractional-hours storage (`% 24` on decimals); whether `cutOffTimeFrom`+`cutOffMinutesFrom` both hydrate from a single `cutOff` field (possible FM bug); confirm `NASH_DELIVERY` is the backend enum; confirm `GET /api/menu/{ref}` nests a `settings` object.

---

# Section 3 — Admin portal (SUPER_ADMIN)

Foundation in `fm-admin-portal-audit.md` + `fm-super-admin-audit.md`. Per-route status:

| Route | Status | Reference / gap |
|---|---|---|
| `/admin/dashboard` | partial | Endpoint canonicalized to `/stats` (`3721ffb`). |
| `/admin/manage-orders` | partial | List + status. Missing refund + detail drawer (SA audit § B/D.1). |
| `/admin/content-management` | matches | 8-section editor. |
| `/admin/manage-users` (diners) | matches | List + disable + Add User (`34cfb97`). |
| `/admin/manage-customers` | matches | Read-only + CSV. |
| `/admin/manage-admins` (System Admins) | matches | Multi-location assignment (`7574757`, `feb1590`). |
| `/admin/manage-restaurants/ordering` | matches | List + toggles + Add Restaurant (`018d868`). |
| `/admin/manage-restaurants/marketplace` | matches | Block toggle (`8999da1`). |
| `/admin/manage-restaurants/bulk-import-menu` | matches | External menuupload service. |
| `/admin/manage-menus` | stub (matches FM stub) | FM's is empty too. |
| `/admin/manage-banking` | stub (matches FM stub) | Coming Soon. |
| `/admin/manage-settings` | stub (matches FM stub) | Coming Soon. |
| Tax Configuration (`/admin/tax-rate`) | **missing** | FM has it (SA audit § E.1, GET/PUT `/api/restaurants/taxRate`). Not built. |
| **Lead Gen fees config** | **DIVERGES — see § 3.A** | user-flagged. |

## 3.A — Lead Gen fees (PRIORITY)

**FM reality** (confirmed source): Lead Gen 1 / Lead Gen 2 are configured **only on the Add Restaurant form**, nowhere else.

- Form controls `lead_gen_1` (default **15**, min 0 max 100) and `lead_gen_2` (default **3**, 0-100) — `add-restaurant.component.ts:231-232`, `add-restaurant.component.html:145-167`. Both are **percentage** fields (percent icon, 0-100).
- Stored on the restaurant as `leadGenOne` / `leadGenTwo` (`restaurant.model.ts:13-14`); payload `add-restaurant.component.ts:117-118`.
- They are **withheld from the restaurant's payout**: net = `grossSumPickUp − (stripeFeeSum + refundsSum + leadgenonediscofee + leadgentwodiscofee)` (`print-summary-template.component.ts:382-388`).
- Displayed as positive cards on the Reporting dashboard (`leadgenonediscofee`, `leadgentwodiscofee`).
- **No platform-level config, no per-restaurant edit-after-creation UI, no lead-gen source attribution** in FM (`[NEEDS REVIEW]` — the dashboard sums fees but doesn't track which order came from which source).

**Disco Cater status**:
- `AddRestaurantDialog.tsx:58-59, 114-115, 186-187` HAS `leadGenOne`/`leadGenTwo` — but as **free-text optional inputs with no default and no 0-100 validation**. **DIVERGES** from FM's number-with-defaults-15/3.
- No edit-after-creation UI (matches FM's gap).
- Lead gen fees are NOT surfaced in any Disco payout/withholding view. The Disco Reporting dashboard shows "Lead Gen 1/2" cards (`dashboard/page.tsx` — `leadgenonediscofee`/`leadgentwodiscofee`) so the display exists, but the configuration round-trip is weak (free text).

**The user's flag** ("lead gen missing from SUPER_ADMIN portal") resolves to: FM never had a dedicated lead-gen config page — it's only on restaurant creation. The real gap is (a) Disco's create form uses free-text instead of FM's number+defaults+0-100, and (b) neither has post-creation editing. A Disco enhancement (number fields + defaults + an edit path) would EXCEED FM, so flag for a decision.

---

# Section 4 — Cross-cutting concerns

## 4.1 Fee logic (PRIORITY) — complete map

| Fee | FM field | Configured (level) | Who absorbs | Disco status |
|---|---|---|---|---|
| Service charge | `serviceCharge` (+ `serviceChargeName`) | **per-menu** (`settings`) | diner | partial — display ok; per-menu edit missing (§ 2.A) |
| Stripe processing | `stripeFeeSum` | auto-calculated | restaurant (withheld) | display only |
| Lead Gen 1 | `leadGenOne` | **per-restaurant** (create form) | restaurant (withheld) | diverges (§ 3.A) |
| Lead Gen 2 | `leadGenTwo` | per-restaurant | restaurant (withheld) | diverges (§ 3.A) |
| Own delivery fee | `ownDeliveryFee` ($) / `ownDeliveryFeePercent` (%) + secondary tier | **per-menu** | diner | missing edit UI (§ 2.A) |
| Third-party delivery fee | `thirdPartyDeliveryFee` / `doordashDeliveryFee` | per-menu / backend | diner | display only |
| Third-party subsidy/withholding | `thirdPartyDeliverySubsidingPercent` (default 20) | **per-menu** | restaurant/platform split | missing edit UI (§ 2.A) — user-flagged |
| Pickup tips | `pickupTipsInPrice` | per-order (diner) | diner | ✅ (tip fixed `be732ad`) |
| Own delivery tips | `owndeliveryTipsInPrice` | per-order | diner | display |
| Third-party delivery tips | `thirdPartyDeliveryTipsInPrice` | per-order | diner | display |
| Tax (state/local/other) | `stateSalesTaxInPrice` etc. | **platform/location** (no per-restaurant override) | diner | deferred-to-checkout display |
| Discount / coupon | `discount` | per-restaurant coupon | diner | order-settings coupon built |
| Refund | `refund` | per-order | restaurant (reduces payout) | restaurant drawer refund present |

**Biggest fee gaps**: per-menu Tips & Surcharges + Delivery Fulfillment + third-party subsidy are not editable in Disco (all in § 2.A); lead-gen config diverges (§ 3.A).

## 4.2 Notification system
FM: email notification mode (ALL/ORDERS_ONLY/OFF) + recipients, text notifications + recipients, customer/restaurant reminder toggles, print kitchen tickets, all on the restaurant Order Settings page (built — `7c2b423`). **No admin-facing email-template editor exists in FM** (confirmed in SA audit § E.6). Diner `/account/notifications` not reconciled `[NEEDS REVIEW]`.

## 4.3 Reporting / analytics
Restaurant dashboard ~20 metric cards built; SA dashboard built. Aggregation: SA aggregates by default in FM (Track 2 doc). Scheduled reports / custom report builder (Orca 3.4) — **green-field, not in FM** beyond the read-only dashboard. Export: per-page CSV on admin Customers only.

## 4.4 Order lifecycle states
FM statuses (DUE, UNPAID, PAID, COMPLETED, REOPEN, CANCELED, VOID, etc.) — restaurant Orders page maps these with status dropdown + terminal-state handling. Transitions via `orderStatusesToChange`. Built. Admin-side detail drawer missing (§ 3 / SA audit D.1).

## 4.5 Permissions matrix
Role gating: middleware (`middleware.ts`) gates `/restaurant/*` (ADMIN/SYSTEM_ADMIN/SUPER_ADMIN), `/admin/*` (SUPER_ADMIN only), `/account|/portal` (diner). Sidebar gating: ADMIN gets reduced nav, SA gets full (`fm-authorized-users-audit.md` § A.6). `REGIONAL_ADMIN` role exists in FM but is unhandled in Disco (flagged). FM auto-filters SA endpoints by JWT (proven). Cross-location grant rejection server-side `[NEEDS REVIEW]` — verified via curl per prior note.

## 4.6 Scheduling & availability
FM determines diner pickup/delivery times via `GET /public-api/menuReference/{ref}/availableTime?date=` (server-side). **Disco computes times CLIENT-SIDE** from `scheduleOption` (`computeTimes`/`computeDates` in `RestaurantClient.tsx`) — flagged in `diner-flow-eye-test-audit.md` as functional, needs reconciliation against the FM endpoint. Menu-level overrides (`skippedDays`) not editable in Disco (§ 2.A). Restaurant-level closed-days built in Order Settings.

---

# Section 5 — Summary

### Counts
- **Diner routes**: 17 found. ~7 matches, ~8 partial, 1 diverges-by-design (favorites), 1 missing (city pages, needs confirmation).
- **Restaurant-portal routes**: ~22. Most partial/matches; **1 diverges (per-menu Settings — the big one)**.
- **Admin-portal routes**: ~14. Most matches; Tax Config missing; lead-gen diverges.
- **Cross-cutting gaps**: per-menu fee editing, lead-gen config shape, client-side scheduling, REGIONAL_ADMIN unhandled.

### Highest-impact FINANCIAL gaps (ranked)
1. **Per-menu Delivery Fulfillment not editable** — own-delivery $/% (primary + secondary) + `thirdPartyDeliverySubsidingPercent`. Restaurants can't set delivery pricing/withholding from Disco. (§ 2.A)
2. **Per-menu Tips & Surcharges not editable** — tip presets + service charge per menu. (§ 2.A)
3. **Lead-gen config diverges** — free-text vs number+defaults 15/3; affects payout withholding. (§ 3.A)
4. **Menu category enum wrong** — drives marketplace placement. (§ 2.A)
5. **`deliveryType` enum wrong** (`THIRD_PARTY` vs `NASH_DELIVERY`) — would mis-route delivery. (§ 2.A)

### Highest-impact FUNCTIONAL gaps (ranked)
1. Client-side scheduling vs FM `availableTime` endpoint (§ 4.6) — diners may see wrong slots.
2. Menu Scheduling Override (skippedDays) not editable (§ 2.A).
3. Admin order detail drawer + refund missing (§ 3).
4. Tax Configuration page missing (§ 3).
5. REGIONAL_ADMIN role unhandled in sidebar/routing (§ 4.5).
6. Reporting Track 2 aggregate gate (held back).

### Recommended build order (grouped into 1–3h sessions)

**Session A — Per-menu Settings dialog completion (financial, highest priority).** Add the three missing editable sections to `MenuSettingsDialog.tsx`: Tips & Surcharges (presets + custom + service charge/name), Delivery Fulfillment (deliveryType OWN_DELIVERY/NASH_DELIVERY, primary+secondary radius + $/% fee, third-party subsidy %), Menu Scheduling Override (skippedDays modal). Fix the two enums (menuCategory → GENERAL_CATERING set; deliveryType THIRD_PARTY → NASH_DELIVERY). Deliverable: per-menu Settings reaches FM parity.

**Session B — Lead-gen config + delivery-fee verification.** Convert Disco's lead-gen inputs to number(0-100) with defaults 15/3 matching FM; verify the full delivery-fee round-trip through the cart math now that § 2.A fields are editable. Add cart tests for own-delivery $ vs % and third-party subsidy. Deliverable: lead-gen + delivery fees reconcile end-to-end.

**Session C — Scheduling parity.** Replace client-side `computeTimes`/`computeDates` with FM's `GET /public-api/menuReference/{ref}/availableTime?date=`. Deliverable: diner sees FM-accurate slots.

**Session D — Admin order detail + refund + Tax Config.** Build the admin-side order detail drawer with refund (SA audit D.1) and the Tax Configuration page (SA audit E.1). Deliverable: admin order ops + tax config.

**Session E — Reporting Track 2 + REGIONAL_ADMIN.** Ship the SA aggregate-reporting gate removal (after live-verifying the aggregate endpoint), and handle the REGIONAL_ADMIN role in sidebar/routing. Deliverable: reporting parity + role completeness.

**Session F (later) — diner profile/notifications/security reconciliation + city pages confirmation.** Lower priority, functional/cosmetic.

### Open questions for the user
1. **Menu category enum** — confirm FM's per-menu `type` uses the GENERAL_CATERING set (not the FAMILY_MEAL/KITS set Disco currently shows). Are these two distinct fields (`menuType` vs `menuCategory`)?
2. **Lead-gen** — FM has no edit-after-creation or platform config. Do you want Disco to ADD that (exceeding FM), or mirror FM and only set lead-gen at restaurant creation?
3. **Third-party subsidy** — FM defaults `thirdPartyDeliverySubsidingPercent` to 20 when cleared but labels it "0-15%". Mirror the 20 default, or treat the label as the intended cap? (Mirror FM unless told otherwise.)
4. **City pages** — does FM have `/new-york` etc. landing pages Disco should build, or are those Disco-only marketing?
5. **Scheduling** — OK to switch to FM's server `availableTime` endpoint (Session C), accepting an extra request per date selection?
6. **REGIONAL_ADMIN** — wire it now (it exists in FM) or wait for Project Orca 3.1?
