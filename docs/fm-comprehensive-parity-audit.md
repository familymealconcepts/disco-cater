# FM Comprehensive Parity Audit — All Three Login Types (field-level)

> Read-only master audit, 2026-05-28 (redone with field-level depth; reconciled against BOTH the FM Angular source AND the actual Disco files, not just FM). Single index across diner, restaurant-portal, and admin-portal surfaces. Where a prior audit doc covers ground it is referenced by name + a one-paragraph delta of anything new found this pass. The four user-flagged priorities (per-menu Settings § 2.A, lead-gen § 3.A, third-party withholding § 2.A + § 4.1, fee logic § 4.1) get the deepest treatment.
>
> **Honesty note:** the first draft over-counted gaps by reconciling only the FM side and marking unread Disco pages "partial/[NEEDS REVIEW]". This pass read the Disco files and **corrected several false gaps** — Account/Profile (all 5 forms present), Reports (full scheduled-reports infra present), Group/Modifier Library, Tax Rate, Banking, Customers, and diner Profile/Addresses all actually **match FM**. The diner `/account/notifications` "potential bug" was wrong (it's a no-op stub). Real remaining divergences are concentrated in § 2.A (per-menu Settings) and § 3.A (lead-gen).
>
> FM Angular source root: `/Users/peterventi/Desktop/familymeal-backend/src/app/`. Every divergence cites `file:line`.

---

# Section 0 — Methodology

- **In scope**: every route under `app/(customer)/`, `app/(restaurant)/`, `app/(admin)/`, plus six cross-cutting concerns.
- **Method**: read the FM component + template + service, cite `file:line`; read the Disco file, cite line; classify divergence + severity.
- **Severity**: **financial** (money a customer/restaurant sees or is charged) > **functional** (wrong behavior/display) > **cosmetic** (visual).
- **Status**: `matches` / `partial` / `missing UI` (field exists in type/preserved but no editable control) / `missing` / `diverges` / `ahead` (Disco exceeds FM).
- **Prior docs referenced (not duplicated)**: `fm-restaurant-portal-audit.md`, `fm-admin-portal-audit.md`, `fm-super-admin-audit.md`, `fm-marketplace-and-access-audit.md`, `fm-authorized-users-audit.md`, `fm-stripe-card-storage-audit.md`, `fm-pricing-reconciliation.md`, `fm-cart-checkout-reconciliation.md`, `fm-multi-location-runtime-audit.md`, `diner-flow-eye-test-audit.md`, `project-orca-scope.md`, `revyrie-tickets/*`. Recurring gotchas: see `README.md`.

---

# Section 1 — Diner (customer) login

## 1.1 — `/` homepage
- **FM**: `pages/public/home/home.component.ts:1-34`. Hero + restaurant search; `GET /public-api/restaurants` (`home.component.ts:26-28`); click → `/{businessNameWithoutSpaces}`.
- **Disco**: `app/(customer)/page.tsx`. Marketing homepage with GlobalHeader.
- **Status**: partial (cosmetic). Not field-reconciled; marketing surface.
- **Gap**: none financial.

## 1.2 — `/fullmap`
- **FM equivalent**: `pages/public/explore/explore.component.ts:123-127, 225-236`; `GET /public-api/restaurants/explore?type={ORDERING|MARKETPLACE}` (forkJoin of both).
- **Disco**: `app/(customer)/fullmap/page.tsx` — sources from Sanity, not FM explore.
- **Status**: diverges (data source). No price display; Haversine distance (`fullmap/page.tsx:29-33`) standard.
- **Gap**: fullmap not FM-sourced — `fm-marketplace-and-access-audit.md` § A.3 (deferred). Functional. Filter by `marketplaceVisible` blocked on the Revyrie ticket.

## 1.3 — `/restaurants/[slug]` (ordering page + cart)
- **FM**: `pages/public/checkout/checkout-pantry`. Cart math + tips + service charge + grand total.
- **Disco**: `RestaurantClient.tsx` + `lib/pricing/*`.
- **Status**: matches (post tip-fix). Fully swept in `diner-flow-eye-test-audit.md` § B.1; cart-line math in `fm-cart-checkout-reconciliation.md`. FM slug fallback added (`bc91d3a`).
- **Delta this pass**: default menu = raw `menus[0]` (FM `checkout-pantry.component.ts:579`); Disco sorts by `position` (`page.tsx`, commit `476ecd0`) — safe no-op when absent. **Scheduling computed client-side** (`computeTimes`/`computeDates`) vs FM's server `availableTime` endpoint — see § 4.6. Functional.

## 1.4 — `/restaurants/[slug]` checkout drawer
- **FM**: `checkout-sidebar-preview`. **Disco**: `CheckoutDrawer.tsx`.
- **Status**: matches/partial. Tip (fixed `be732ad`) + svc correct; tax + delivery deferred to "Calculated at checkout" (matches FM); Estimated Total omits tax/delivery by design — `diner-flow-eye-test-audit.md` § B.2. Saved-card use via `useDefaultPayment` — `fm-stripe-card-storage-audit.md`.

## 1.5 — `/account/orders`
- **FM**: `pages/private/user/order-history/order-history-table.component.ts:1-131`; `GET /api/userOrder` (paginated, page/size/sort/search/fromDate/toDate). Columns: orderNumber, restaurantName, orderDate (MM/dd/YY), orderTime (12h), dropOffTime, orderType, total.
- **Disco**: `account/orders/page.tsx` — calendar + list; `fmtMoney(o.total)` server value.
- **Status**: matches (financial). Calendar view is a Disco addition (`ahead`).

## 1.6 — `/account/orders/[id]` (order detail panel)
- **FM**: `order-history-details.component.ts:1-92`, `GET /api/userOrder/{reference}`. Shows customer, restaurant, timing, full pricing breakdown (subtotal, delivery own+doordash+thirdParty, fee, tax state/local/other, tips, discount, maxAllowedRefundAmount), items (orderMealPackages/orderClassics/orderSubscription with addOns).
- **Disco**: `OrderDetailPanel.tsx`. `/pp` per-person display intentional; line items via `lib/pricing/lineItem`.
- **Status**: matches (financial — server totals) + **ahead**.
- **DELTA — important**: **FM order history has NO "Reorder" and NO "Make recurring" actions** (`order-history-table.component.html` has no such buttons; no `order.service` reorder/recurring methods). Disco's OrderDetailPanel HAS both (built per Project Orca). So Disco is **ahead of FM** here — these are NOT parity gaps; they are Orca features Disco shipped early. Keep, don't "fix to match FM".

## 1.7 — `/account/subscriptions`
- **FM**: subscriptions list (shipped: list/pause/resume/cancel/hide; create/skip/edit not shipped — see `project-orca-scope.md`). **Disco**: `subscriptions/page.tsx` — server totals + history-driven "make recurring" upsell (Disco addition).
- **Status**: matches + ahead.

## 1.8 — `/account/orders/history`
- **FM**: same `order-history` table filtered. **Disco**: `account/orders/history/page.tsx`, `fmtMoney(o.total)`.
- **Status**: matches.

## 1.9 — `/account/profile`, 1.10 `/account/security`, 1.11 `/account/addresses`
- **FM — ONE bundled page**: `pages/private/user/account/account.component.ts:1-359` combines profile + password + delivery address.
  - Profile: firstName/lastName (1-50, required), phoneNumber (mask, pattern `account.component.ts:97`), email (read-only). `PUT /api/users` (`account.service.ts:100-103`).
  - Password: oldPassword + newPassword (8-50). `POST /api/changePassword` (`account.service.ts:80-84`).
  - Address: **single address per user** (not multi). `GET/PUT /api/users/addresses` (`account.service.ts:110-119`). Google Places autocomplete; lat/lng required.
- **Disco — split into THREE pages** (verified this pass):

| FM field/section | FM src | Disco field | Disco src | Status |
|---|---|---|---|---|
| firstName | acct:86 | firstName | profile/page.tsx:86 | matches |
| lastName | acct:90 | lastName | profile/page.tsx:90 | matches |
| email (read-only) | acct:95 | email (type email) | profile/page.tsx:95 | matches |
| phoneNumber | acct:99 | phone | profile/page.tsx:99 | matches |
| — (FM has no field) | — | deliveryInstructions (textarea) | profile/page.tsx:103 | **ahead** |
| `PUT /api/users` | acct.service:100 | `PUT /api/fm-user` | profile/page.tsx:58 | matches |
| address single {addressLine1,city,state,zipcode} | acct.model:45 | addressLine1/city/state/zip (single) | addresses/page.tsx:100-113 | matches (single) |
| `PUT /api/users/addresses` | acct.service:116 | `PUT /api/fm-user-addresses` | addresses/page.tsx:74 | matches |
| password change oldPassword+newPassword | acct:209-238 | **STUB** "coming soon" | security/page.tsx:7-12 | **MISSING** |

- **Status**: profile **matches** (+ahead: deliveryInstructions); addresses **matches** (single-address model, same shape, same endpoint); **security page is a STUB** — FM has `POST /api/changePassword`, Disco renders only a "coming soon" placeholder. Splitting one FM page into three is cosmetic-structural, not a divergence.
- **Real gap**: `/account/security` change-password not implemented (functional). Disco's restaurant portal already has `POST /api/restaurant/change-password` (§ 2.E) to mirror.

## 1.12 — `/account/notifications`
- **FM**: **NO diner-side notification preferences UI exists** (NotificationService endpoints `/api/notifications`, `/api/orderSettings` exist but no diner component wired).
- **Disco**: **STUB** — `notifications/page.tsx:7-12` renders only "Notification settings coming soon." No toggles, **no API call**.
- **Status**: matches (both have no functional diner notification UI). **Corrects prior pass**: there is NO bug — the page makes no request, so the "writes restaurant-scoped `/api/notifications`" concern is moot. (For reference, Disco's restaurant-scoped proxy lives at `app/api/restaurant/notifications/route.ts` → FM `/api/notifications`; the diner stub does not touch it.) Not a parity gap; building it would exceed FM.

## 1.13 — `/account/payment`
- **FM**: `payment-card` single-card. **Disco**: fixed this week (cardToken field, 404→null, Element mount). `fm-stripe-card-storage-audit.md`.
- **Status**: matches.

## 1.14 — `/account/favorites`
- **FM**: none (no favorites endpoint). **Disco**: per-user localStorage (`useFavorites`).
- **Status**: ahead / diverges-by-design. Documented.

## 1.15 — `/faq`
- Static. matches.

## 1.16 — `/order-confirmation/[orderRef]`
- **FM**: `pages/public/order-confirmed/order-confirmed.component.ts:1-89` — reads from **localStorage `preOrder`** (NOT an API fetch), shows orderNumber, customer, total, restaurant, timing, delivery window, items, full pricing breakdown, notes. Redirects home if no preOrder.
- **Disco**: `order-confirmation/[orderRef]/page.tsx` — fetches by orderRef (API-based, more robust than FM's localStorage approach).
- **Status**: diverges-by-design (Disco is more robust). `[NEEDS REVIEW]` confirm the confirmation fields match FM's breakdown.

## 1.17 — City landing pages (`/new-york`, `/los-angeles`, `/new-jersey`)
- **FM — THESE EXIST**: route `/locations/:locationUrl` (`locations-routing.module.ts:7`, also `/disco/locations/:locationUrl`). Component `pages/public/locations/locations.component.ts:1-98`. Endpoint `GET /public-api/restaurants/links/{locationUrl}` (`restaurant.service.ts:115`). Returns `{ image, header, groupedRestaurants: [{ state, restaurants: [{ businessName, businessNameWithoutSpaces, reference, address }] }] }`. Restaurants grouped by state with a hero image + header.
- **Disco**: **MISSING** — no `/locations/[url]` or city routes found under `app/(customer)/`.
- **Status**: **missing**. Functional. Correction to prior pass which said "[NEEDS REVIEW] confirm exists" — they DO exist in FM as `/locations/{url}`, backed by the multi-unit links system (the Links page builds these).
- **Note**: this ties to the Links page (§ 2.16) — the multi-unit links ARE the city/group landing pages.

### Section 1 gaps summary
| Gap | Severity |
|---|---|
| `/account/security` change-password is a stub (FM has `POST /api/changePassword`) | functional |
| City `/locations/{url}` landing pages missing | functional |
| Fullmap not FM-sourced | functional (deferred) |
| Client-side scheduling vs FM `availableTime` (§ 4.6) | functional |

(Removed from prior draft: profile/address are now confirmed **matching**; `/account/notifications` is a no-op stub, not a bug.)

---

# Section 2 — Restaurant portal (SYSTEM_ADMIN + ADMIN)

Foundation: `fm-restaurant-portal-audit.md`. Per-page status table, then the deep § 2.A.

| # | Route | Role | Status | Reference / delta |
|---|---|---|---|---|
| 2.1 | `/restaurant/login` | all | matches | role routing `4c212ea` |
| 2.2 | `/restaurant/dashboard` (Reporting) | SA+ADMIN | partial | aggregate-by-default held back (`fm-multi-location-runtime-audit.md` Track 2) |
| 2.3 | `/restaurant/manage/locations` | SA | matches | row-click drilldown |
| 2.4 | `/restaurant/manage/authorized-users` | SA | matches | `fm-authorized-users-audit.md` |
| 2.5 | `/restaurant/orders` | SA+ADMIN | matches | SA aggregated (`840c609`); drawer refund/void/complete/print/notes |
| 2.6 | `/restaurant/manage-v2/menus` (list) | SA+ADMIN | matches − drag (§ 2.B) | tabs+clone+visible+archive+delete present; only drag-reorder missing |
| 2.7 | `/restaurant/manage-v2/[menuRef]/settings` | SA+ADMIN | **DIVERGES — § 2.A** | the big one |
| 2.8 | `/restaurant/manage/groups` (Group Library) | SA+ADMIN | matches − drag (§ 2.C) | all 6 fields + clone/archive present |
| 2.9 | `/restaurant/manage/modifiers` (Modifier Library) | SA+ADMIN | matches − drag (§ 2.C) | name/price + clone/archive present |
| 2.10 | `/restaurant/order-settings` (Settings) | SA+ADMIN | matches | built `7c2b423`; full field list § 2.D |
| 2.11 | `/restaurant/account/profile` | ADMIN | **matches (§ 2.E)** | all 5 forms + dual image upload present |
| 2.12 | `/restaurant/account/banking` (Stripe Connect) | ADMIN | matches (§ 2.F) | connect/disconnect/status present |
| 2.13 | `/restaurant/tax-rate` | SA | matches (§ 2.G) | state/local/other + %/$ + Other types |
| 2.14 | `/restaurant/restaurant-customers` | SA+ADMIN | matches − export fmt (§ 2.H) | CSV vs FM Excel |
| 2.15 | `/restaurant/manage/admin-manager-reports` (Reports) | SA | **matches (§ 2.I)** | full scheduled-reports infra IS built |
| 2.16 | `/restaurant/manage/multi-unit-links` (Links) | SA | matches | `11039eb`; powers city pages (§ 1.17) |

## 2.A — Per-menu Settings dialog (TOP PRIORITY — full field-by-field)

**FM**: `admin/manage-menus-v2/menus-v2/menu-settings-v2/menu-settings-v2.component.{ts,html}`. FormGroup `ts:150-202`. Service `_system/_services/menu/menu.service.ts`. Endpoints: `GET /api/menu/{ref}`, `PUT /api/menu/{ref}`, `POST /api/menu`, `PUT /api/menu/{ref}/visible?isVisible=`, `PUT /api/menu/{ref}/archive?isArchived=` (`menu.service.ts:40-64`).

**Disco**: `app/(restaurant)/restaurant/(portal)/manage-v2/menus/MenuSettingsDialog.tsx` (582 lines). Save spreads `...menu.scheduleOption` (line 248) and `...menu.settings` (line 260) — so unrendered fields are **preserved but not editable**.

### Full field table

| FM section | FM field (FormControl → API) | FM src | Disco field | Disco src | Divergence | Severity |
|---|---|---|---|---|---|---|
| **Menu Details** | menu name `menuName`→`name` | ts:224, html:15 | `name` | MSD:104,352 | none | — |
| | category `menuCategory`→`type`; enum GENERAL_CATERING/OFFICE_CATERING/HOLIDAY_CATERING/MEAL_PREP/PRIVATE_CHEF/NATIONWIDE_SHIPPING/MERCH/POP_UP | fake-data:675-716, html:23 | `type`, enum FAMILY_MEAL/CATERING/KITS/BEVERAGES/PANTRY/CHEFS_TABLE/POPUP/COLLABS/DRINKS/SERIES | MSD:60-71,357 | **DIVERGES — wrong enum** | financial-adjacent (marketplace placement) |
| | URL slug `url`→`url`, pattern `^[A-Za-z0-9-_]+$` | ts:226, html:33 | `url` | MSD:106,363 | none | — |
| | image (cropper) → `image.reference` (separate upload) | html:49 | — | — | **missing** | functional |
| **Menu Availability** | `menuAvailability` default/custom; `from`/`to` → `scheduleOption.startDate`/`endDate` | html:67-94 | — (scheduleType only) | — | **missing UI** (date-range) | functional |
| **Pickup Window** | `isSameDay` enabled/disabled → `scheduleType` SAME_DAY/CUSTOM | html:103-106 | `scheduleType` | MSD:115,395-396 | none | — |
| | per-day `repeatWeekDays[]{days,fromPickUpTime,toPickUpTime}` (24h) | ts:1173-1207 | same | MSD:225-231,404-441 | none | — |
| **Prep Time** | `prepDays`+`prepTime` → `scheduleOption.prepTime` = days×24+hrs | ts:970, html:254-266 | `prepDays`+`prepHours` | MSD:132-133,242,452-457 | none (Disco caps hrs ≤23) | — |
| **Order Cut-off** | `cutOffType` NO/DAILY/BY_DATE; `cutOff`,`cutOffDate` | html:283-327 | `cutOffType` DAILY/BY_DATE | MSD:134,473-487 | minor — Disco has no "NO" option (always DAILY/BY_DATE) | functional |
| **Order Minimums** | `pickupOrderMinimum`,`deliveryOrderMinimum`→`settings.*` | html:337-347 | same | MSD:139-140,500-505 | none | — |
| **Tips & Surcharges** | tip preset `tipSize` (10/15/20/Custom from FAKE_FEES) + `customTipSize` → `settings.tipOption{tipsPrice,tipsType PERCENTAGE/CUSTOM}` | fake-data:313-338, ts:1009-1012 | type only (`tipOption`) | MSD:39 (preserved 260) | **missing UI** | **financial** |
| | `serviceCharge` (percentage pts) + `serviceChargeName` → `settings.*` | html:392-401 | type only | MSD:37-38 (preserved 260) | **missing UI** | **financial** |
| **Rolling Availability** | `rollingAvailability` 30/60/90 | ts:61, html:416 | same | MSD:131,462-465 | none | — |
| **Max Orders/15-min** | `maxOrderVariant`+`maxOrder` → `scheduleOption.maxOrder` | html:434-445 | `maxOrder` (labeled "Max orders/day") | MSD:141,510 | minor — Disco labels it per-day, FM per-15-min | functional |
| **Pickup & Delivery Avail.** | `menuAvailability[]` PICKUP/DELIVERY | html:458 | pickup/delivery checks | MSD:111-112,379-380 | none | — |
| **Delivery type** | `deliveryType` enum **OWN_DELIVERY / NASH_DELIVERY** | fake-data:802-813, html:468 | type `'OWN_DELIVERY' \| 'THIRD_PARTY'` | MSD:29 | **DIVERGES — third-party value `THIRD_PARTY` vs FM `NASH_DELIVERY`**, AND no UI | **financial** (delivery routing) |
| **Self-delivery PRIMARY radius** | `ownDeliveryRadius` (miles, precision 1) | html:481 | type only | MSD:30 (preserved) | **missing UI** | **financial** |
| **Self-delivery PRIMARY fee** | `ownDeliveryFee` ($, 2dp) OR `ownDeliveryFeePercent` (%, 3dp) via $/% toggle (FAKE_OWN_DELIVERY_FEE_TYPES) | html:489-510 | types only | MSD:31-32 (preserved) | **missing UI** (incl. the $/% toggle) | **financial** |
| **Self-delivery SECONDARY radius** | `secondaryOwnDeliveryRadius` | html:512 | type only | MSD:33 (preserved) | **missing UI** | **financial** |
| **Self-delivery SECONDARY fee** | `secondaryOwnDeliveryFee` ($) OR `secondaryOwnDeliveryFeePercent` (%) via $/% toggle | html:520-532 | types only | MSD:34-35 (preserved) | **missing UI** | **financial** |
| **Third-party withholding** | `thirdPartyDeliverySubsidingPercent` (defaults **20** if cleared; UI label "0-15%", no validation) | html:544, ts:846-852 | type only | MSD:36 (preserved) | **missing UI** | **financial** (platform/restaurant split) |
| **Menu Scheduling Override** | `skippedDays[]{name,fromDate,toDate,intervals[]{fromTime,toTime}}` via skipped-days modal; "Closed All Day" vs "Custom" | ts:1022-1023, fake-data:763-774 | type only | MSD:23 (preserved 248) | **missing UI** | functional |

### FM PUT payload (verbatim shape, `menu-settings-v2.component.ts:958-1066`)
```
{ name, type, url,
  scheduleOption: {
    scheduleType: 'SAME_DAY'|'CUSTOM',
    repeatWeekDays: [{ days:'MONDAY,...', fromPickUpTime:'09:00', toPickUpTime:'17:00' }],
    startDate?, endDate?,
    prepTime: number,            // prepDays*24 + hours
    cutOff?, cutOffType?, cutOffDate?,
    rollingAvailability, maxOrder,
    skippedDays?: [{ name, fromDate, toDate, intervals:[{fromTime,toTime}] }]
  },
  settings: {
    pickupOrderMinimum, deliveryOrderMinimum,
    tipOption: { tipsPrice, tipsType:'PERCENTAGE'|'CUSTOM' },
    serviceCharge, serviceChargeName,
    menuAvailability: ['PICKUP'|'DELIVERY'],
    deliveryType: 'OWN_DELIVERY'|'NASH_DELIVERY',
    ownDeliveryRadius, ownDeliveryFee, ownDeliveryFeePercent,
    secondaryOwnDeliveryRadius, secondaryOwnDeliveryFee, secondaryOwnDeliveryFeePercent,
    thirdPartyDeliverySubsidingPercent
  } }
```

### § 2.A verdict
Disco edits **8 of 12 sections**. The **3 most fee-relevant sections are missing editable UI** (Tips & Surcharges; the entire Delivery Fulfillment block incl. primary+secondary radius/$%fee + NASH subsidy; Scheduling Override) — preserved-not-rendered. Plus **2 wrong enums** (menu category; deliveryType third-party value). This is exactly the user's flag.

`[NEEDS REVIEW]`: (a) is `menuType` distinct from the v2 `menuCategory` (`type`)? (b) prep-time fractional hours (`%24` on decimals, ts:238-239); (c) confirm `NASH_DELIVERY` backend enum; (d) the "0-15%" label vs default-20 behavior.

## 2.B — Manage Menus list (`/restaurant/manage-v2/menus`)
- **FM**: `menus-table.component.ts:29-187`. Columns: drag, menuName, menuType, startDate, endDate, image, settings, actions. **Drag-reorder** via `PUT /api/menu/{ref}/position?position={pos}` (index adjusted for pagination, `:178-184`). Kebab: clone, visible toggle, archive, delete. Tabs active/inactive/archived.
- **Disco** (verified): `manage-v2/menus/page.tsx`. Tabs Active/Inactive/Archived (`:121-135`, filter ACTIVE/NON_VISIBLE/ARCHIVED). Columns name/type(TYPE_LABELS `:29`)/startDate/endDate/image/actions (`:146-151`). Kebab: Menu Settings (`:178`), Clone (`:191`→`POST .../clone`), Hide/Show (`:193`→`PUT .../visible?isVisible=`), Archive/Unarchive (`:197`→`PUT .../archive?isArchived=`), Delete (`:200`).
- **Status**: **matches except drag-reorder** — no `position` PUT (`:68-101` has no reorder handler). Functional. Only real gap on this page.

## 2.C — Group Library + Modifier Library

### Group Library
- **FM**: `admin/manage-menus/groups/`. `POST/PUT/DELETE /api/extraItemsGroups`, `PUT .../{ref}/position`, `POST .../{ref}/clone`, `GET /api/restaurants/{ref}/extraItemsGroups`. Rules: max 50 items/group, min<max, archive sets visible=false.
- **Disco**: `manage/groups/page.tsx` → proxy `/api/restaurant/groups` → FM `/api/extraItemsGroups`.

| FM field/column | Disco field | Disco src | Status |
|---|---|---|---|
| name* | name | groups/page.tsx:29 | matches |
| externalName* | externalName | groups/page.tsx:30 | matches |
| subExternalName* | subExternalName | groups/page.tsx:31 | matches |
| minSelectedItems* | minSelectedItems | groups/page.tsx:32 | matches |
| maxSelectedItems* | maxSelectedItems | groups/page.tsx:33 | matches |
| addOnsReferences[] | addOnsReferences[] | groups/page.tsx:35 | matches |
| clone | clone (`POST .../{ref}/clone`) | groups/page.tsx:187 | matches |
| archive/visible toggle | archive/unarchive | groups/page.tsx:255 | matches |
| drag-reorder (`PUT .../position`) | — | — | **missing** (functional) |
| 50-item cap, min<max validation | `[NEEDS REVIEW]` | — | confirm client validation |

### Modifier Library
- **FM**: `admin/manage-menus/add-ons/`. `POST/PUT/DELETE /api/addOns`, position, clone. Fields `name`*, `price`* (regex `^[0-9]*[.]?[0-9]*$`).
- **Disco**: `manage/modifiers/page.tsx` → `/api/restaurant/add-ons` → FM `/api/addOns`.

| FM field/column | Disco field | Disco src | Status |
|---|---|---|---|
| name* | name | modifiers/page.tsx:16 | matches |
| price* | price (2dp display) | modifiers/page.tsx:19,183 | matches |
| clone | clone (`POST .../{ref}/clone`) | modifiers/page.tsx:128 | matches |
| archive/visible | archive/unarchive | modifiers/page.tsx:188 | matches |
| pagination | prev/next | modifiers/page.tsx:200-214 | matches |
| drag-reorder (`PUT .../position`) | — | — | **missing** (functional) |

- **Status**: both **match FM** except drag-reorder (shared gap with § 2.B). Corrects prior pass's "partial/[NEEDS REVIEW]" — the fields, clone, and archive ARE all present.

## 2.D — Restaurant Order Settings (`/restaurant/order-settings`)
- **FM**: `admin/order-settings/order-settings.component.ts:105-134`. Built in Disco `7c2b423` and reconciled in earlier work. Field list (FM): `businessNameWithoutSpaces` (slug), `announcement` (≤500), `phone`, `email`*, `emailNotificationType` (ALL/ORDERS_ONLY/OFF), `phoneNotificationType`, `autoPrint` (inverted on save), `enableMenuSearch` (inverted), `orderReminderEmailsEnabled` (inverted), `deliveryOrderTimeWindows` ('exact'/range); online ordering toggle `PATCH /api/restaurants/onlineOrdering`; closed days `/api/closedDays`; coupon `/api/coupon`. Endpoints `/api/notifications`, `/api/feesAndTips`.
- **Disco**: built.
- **Status**: matches (per `7c2b423`). Delta: FM inverts `autoPrint`/`enableMenuSearch`/`orderReminderEmailsEnabled` booleans on save (`order-settings.component.ts:457-458,290,610`) — `[NEEDS REVIEW]` confirm Disco inverts identically or it'll toggle backwards.

## 2.E — Restaurant Account/Profile
- **FM**: `admin/account/profile/profile.component.ts:80-132`. FIVE forms + images.
- **Disco** (verified): `account/profile/page.tsx` — **all five forms + both images present**.

| FM form/field | FM src | Disco field | Disco src | Status |
|---|---|---|---|---|
| Profile firstName/lastName/email[ro]/phone | profile.c:80 | firstName/lastName/email/phoneNumber | profile/page.tsx:402-411 | matches |
| Password old+new | profile.c:- | password/newPassword → `POST /api/restaurant/change-password` | profile/page.tsx:418-421,271 | matches |
| Business legalName/city/state/zip (`/api/businessInfo`) | profile.c:- | businessLegalName/city/state/zipcode → `/api/restaurant/business-info` | profile/page.tsx:428-437,295 | matches |
| Address businessName/phone/line1/city/state/zip | profile.c:- | same | profile/page.tsx:444-459 | matches |
| DoorDash pickupInstructions ≤1000 | profile.c:- | pickupInstructions (textarea, 1000 + counter) | profile/page.tsx:468,479 | matches |
| Restaurant image 1:1 | profile.c:- | upload → `/api/restaurant/images/upload` | profile/page.tsx:510-530,366 | matches |
| Marketplace image 4:3 | profile.c:- | upload → `/api/restaurant/images/marketplace` | profile/page.tsx:534-565,367 | matches |
| `PUT /api/restaurants` | profile.c:- | `PUT /api/restaurant/profile` | profile/page.tsx:245 | matches |

- **Status**: **matches**. Corrects prior pass — Disco has the Business form, DoorDash instructions, dual image upload, and password change. `[NEEDS REVIEW]` only on Google-autocomplete lat/lng/timezone resolution parity (functional, minor).

## 2.F — Banking / Stripe Connect
- **FM**: `admin/account/banking/banking.component.ts:18,44-106`. `HEAD /api/stripe/{ref}` (status), `POST /api/stripe/clients/{ref}/connect` (→ stripeConnectUrl), `GET /api/stripe/disconnect/{ref}`.
- **Disco** (verified): `account/banking/page.tsx`. Status via `GET /api/restaurant/stripe-status` (`:44`); connect `POST /api/restaurant/stripe/connect` (`:63`); disconnect `DELETE /api/restaurant/stripe/disconnect` (`:87`, confirm dialog `:165`); status dot + "Stripe (connected/disconnected)" label (`:109-118`).
- **Status**: **matches** (connect/disconnect/status all present). `[NEEDS REVIEW]` confirm the disconnect proxy maps to FM's `GET /api/stripe/disconnect/{ref}`.

## 2.G — Tax Rate
- **FM**: `admin/tax-rate/tax-rate.component.ts:16,36-58`. `GET/PUT /api/restaurants/taxRate`. 3 rows State/Local/Other; each `fixedAmount`($) + `percent`(%); Other has `types[]` (PICKUP/DELIVERY). Body keyed by tax key. Platform-level.
- **Disco** (verified): `restaurant/tax-rate/page.tsx` → `GET/PUT /api/restaurant/tax-rate`.

| FM | Disco | Disco src | Status |
|---|---|---|---|
| stateSalesTax / localSalesTax / otherSalesTax rows | same 3 rows | tax-rate/page.tsx:118-121 | matches |
| percent (3dp) | percent (step 0.001, fmt3) | tax-rate/page.tsx:205,153 | matches |
| fixedAmount ($, 2dp) | fixedAmount (step 0.01, fmt2) | tax-rate/page.tsx:217,154 | matches |
| Other `types[]` PICKUP/DELIVERY | types JSON (textarea, Other only) | tax-rate/page.tsx:224-229 | matches − UX (raw JSON vs checkboxes) |
| totals row | totals row | tax-rate/page.tsx:173-178 | matches |

- **Status**: **matches**. Only nit: Other's `types` is a raw-JSON textarea in Disco vs FM's PICKUP/DELIVERY checkboxes — cosmetic/functional UX, same payload.

## 2.H — Restaurant Customers
- **FM**: `admin/restaurant-customers/`. `GET /api/customer/users` (paginated, search), detail `GET /api/customer/users/{ref}/orders`. List columns username/email/phoneNumber/numberOfOrders/totalspend. **Excel** export.
- **Disco** (verified): `restaurant-customers/page.tsx` + `[customerRef]/page.tsx` → `/api/restaurant/customers`.

| FM | Disco | Disco src | Status |
|---|---|---|---|
| list: username/email/phone/numberOfOrders/totalspend | same columns | customers/page.tsx:132-137 | matches |
| search (debounced) | search (400ms) | customers/page.tsx:104,70 | matches |
| page sizes | 25/50/100/250 | customers/page.tsx:114-125 | matches |
| export Excel | export **CSV** (client-side) | customers/page.tsx:89-99 | **diverges — CSV vs Excel** (cosmetic) |
| detail order history (orderDate/createdDate/orderType/totalSpend) | Order#/Date/Time/Type/Total/**Status** | [customerRef]/page.tsx:128-155 | matches + status col (ahead) |

- **Status**: **matches** except export format (CSV vs FM Excel — cosmetic) and a bonus status column on detail.

## 2.I — Reports (`/restaurant/manage/admin-manager-reports`)
- **FM**: `admin-manager/reports/` — scheduled-reports infra: CRUD `GET/POST/PUT/DELETE /api/reports/scheduled`, `GET /api/reports/columns`, `POST /api/reports/download`, `POST /api/reports/email`, `GET /api/reports/runs`.
- **Disco** (verified): `manage/admin-manager-reports/page.tsx` — **the full infra IS built**. Two tabs Scheduled Reports + Reports Log (`:88-90`).

| FM capability | Disco field/action | Disco src | Status |
|---|---|---|---|
| scheduled list (`GET .../scheduled`) | `/api/restaurant/reports/scheduled` | page.tsx:156 | matches |
| create/update (`POST/PUT`) | full editor modal | page.tsx:382-389 | matches |
| delete | delete + confirm | page.tsx:177 | matches |
| name / frequency WEEKLY-MONTHLY / time / timezone | same | page.tsx:410-425 | matches |
| fileType | CSV / PDF radio | page.tsx:433-440 | matches |
| recipients[] | email-array + chips | page.tsx:444-467 | matches |
| filter: locations / dateType / orderStatuses / deliveryTypes | all rendered | page.tsx:470-521 | matches |
| columns picker (`GET .../columns`) | grouped checkboxes | page.tsx:524-541,336 | matches |
| run logs (`GET .../runs`) | Reports Log tab | page.tsx:258,277-291 | matches |

- **Status**: **matches** — full scheduled-reports CRUD + filters + columns picker + run logs. **Major correction to prior pass** (which claimed this was missing infra). `[NEEDS REVIEW]`: `ownerReferences` (type `admin-manager-reports.tsx:40`) not visibly rendered; confirm `POST .../download` + `.../email` actions are wired (only `scheduled`/`runs`/`columns` proxies confirmed).

---

# Section 3 — Admin portal (SUPER_ADMIN)

Foundation: `fm-admin-portal-audit.md` + `fm-super-admin-audit.md` (gap analysis with build order). Per-page status is in `fm-super-admin-audit.md`; deltas only here.

| Route | Status | Delta this pass |
|---|---|---|
| Dashboard | partial | endpoint `/stats` (`3721ffb`); lead-gen cards present |
| Orders | partial | missing refund + detail drawer (SA audit D.1) |
| Content Management | matches | 8-section editor |
| Users (diners) | matches | `34cfb97` |
| Customers | matches | CSV export |
| System Admins | matches | multi-location assign `7574757`/`feb1590` |
| Restaurants—Ordering | matches | + Add Restaurant `018d868` |
| Restaurants—Marketplace | matches | block toggle `8999da1` |
| Bulk Import | matches | external menuupload |
| Menus / Banking / Settings | stubs (match FM stubs) | — |
| Tax Configuration | **missing** | FM `GET/PUT /api/restaurants/taxRate` (SA audit E.1) |
| **Lead Gen config** | **DIVERGES — § 3.A** | user-flagged |

## 3.A — Lead Gen fees (PRIORITY)
- **FM**: configured ONLY on the Add Restaurant form. `lead_gen_1` (default **15**, min0 max100), `lead_gen_2` (default **3**, 0-100) — `add-restaurant.component.ts:231-232`, `add-restaurant.component.html:145-167`. **Percentage** fields. Stored as `leadGenOne`/`leadGenTwo` (`restaurant.model.ts:13-14`), payload `:117-118`. **Withheld from restaurant payout**: net = grossSumPickUp − (stripeFeeSum + refundsSum + leadgenonediscofee + leadgentwodiscofee) (`print-summary-template.component.ts:382-388`). No platform config; no edit-after-creation; **no per-source attribution** `[NEEDS REVIEW]`.
- **Disco**: `AddRestaurantDialog.tsx:58-59,114-115,186-187` — `leadGenOne`/`leadGenTwo` as **free-text optional, no default, no 0-100 validation**.
- **Divergence**: free-text vs FM number+defaults-15/3+0-100. **financial-adjacent** (drives payout withholding). No edit-after-creation in either.
- **User's "missing from SUPER_ADMIN portal" flag resolves to**: FM never had a dedicated lead-gen page; it lives on restaurant creation. Disco's create form has it but in a weaker shape. A Disco edit-after-creation UI would EXCEED FM (open question § 5).

---

# Section 4 — Cross-cutting

## 4.1 Fee logic — every fee, one row

| Fee | FM field | Config level | Who absorbs | Disco status |
|---|---|---|---|---|
| Service charge | `serviceCharge` (+`serviceChargeName`) | per-menu (`settings`) | diner | partial — display ok; per-menu edit **missing** (§ 2.A) |
| Stripe processing | `stripeFeeSum` | auto | restaurant (withheld) | display only |
| Lead Gen 1 | `leadGenOne` | per-restaurant (create form) | restaurant (withheld) | diverges (§ 3.A) |
| Lead Gen 2 | `leadGenTwo` | per-restaurant | restaurant (withheld) | diverges (§ 3.A) |
| Own delivery fee ($) | `ownDeliveryFee` | per-menu | diner | **missing edit UI** (§ 2.A) |
| Own delivery fee (%) | `ownDeliveryFeePercent` | per-menu | diner | **missing edit UI** |
| Own delivery radius | `ownDeliveryRadius` | per-menu | n/a (gate) | **missing edit UI** |
| Secondary delivery fee/radius | `secondaryOwnDelivery*` | per-menu | diner | **missing edit UI** |
| Third-party delivery fee | `thirdPartyDeliveryFee`/`doordashDeliveryFee` | per-menu/backend | diner | display only |
| Third-party subsidy/withholding | `thirdPartyDeliverySubsidingPercent` (default 20) | per-menu | restaurant/platform split | **missing edit UI** (user-flagged) |
| Pickup tips | `pickupTipsInPrice` | per-order (diner) | diner | ✅ tip fixed `be732ad` |
| Own delivery tips | `owndeliveryTipsInPrice` | per-order | diner | display |
| Third-party delivery tips | `thirdPartyDeliveryTipsInPrice` | per-order | diner | display |
| State sales tax | `stateSalesTaxInPrice` | platform/location | diner | deferred-to-checkout display |
| Local sales tax | `localSalesTaxInPrice` | platform | diner | display |
| Other sales tax | `otherSalesTaxInPrice` (+PICKUP/DELIVERY types) | platform | diner | display |
| Discount/coupon | `discount` | per-restaurant coupon | diner | order-settings coupon built |
| Refund | `refund`/`refundsSum` (`maxAllowedRefundAmount`) | per-order | restaurant (reduces payout) | restaurant drawer refund present; admin refund missing |

**Biggest fee gaps**: all per-menu delivery + tips/surcharge editing (§ 2.A); lead-gen shape (§ 3.A).

## 4.2 Notification system
FM restaurant Order Settings: email mode (ALL/ORDERS_ONLY/OFF) + recipients, text notifications + recipients, customer/restaurant reminder toggles, print kitchen tickets, enable menu search, delivery time windows, announcement (≤500). Built in Disco (`7c2b423`). **No admin email-template editor in FM** (SA audit E.6). **No diner-side notification UI in FM** and **Disco's `/account/notifications` is a no-op stub** (§ 1.12) — so there is no scope-collision bug; the diner stub makes no request. SMS/text via the restaurant phone recipients array. In-app notifications: none in FM.

## 4.3 Reporting / analytics
Restaurant dashboard ~20 cards + SA dashboard built. SA aggregates by default (`fm-multi-location-runtime-audit.md`). **The restaurant scheduled-reports infra IS built in Disco** (§ 2.I — scheduled CRUD + filters + columns picker + run logs); the only `[NEEDS REVIEW]` is whether the ad-hoc `download`/`email` actions are wired. So Project Orca 3.4 reporting is largely done on the restaurant side. Export: per-page CSV (admin Customers) + CSV (restaurant Customers; FM uses Excel — cosmetic).

## 4.4 Order lifecycle states
FM statuses: DUE, UNPAID, PAID, COMPLETED, REOPEN, CANCELED, VOID (+ `orderStatusesToChange[]` drives allowed transitions). Restaurant Orders page maps these with the status dropdown + terminal-state handling — built. Admin-side order detail drawer with the same transitions: **missing** (§ 3). Nash delivery sub-states (`nashDeliveryStatus`, pickup/dropoff ETA) shown on restaurant orders.

## 4.5 Permissions matrix
- Middleware (`middleware.ts`): `/restaurant/*` → ADMIN/SYSTEM_ADMIN/SUPER_ADMIN; `/admin/*` → SUPER_ADMIN only; `/account|/portal` → diner cookie.
- Sidebar gating: ADMIN reduced nav, SA full (`fm-authorized-users-audit.md` § A.6).
- FM auto-filters SA endpoints by JWT (proven). Cross-location grant rejection server-side `[NEEDS REVIEW]` (curl-verified per prior note).
- **`REGIONAL_ADMIN` role exists in FM** (`paths.constant.ts:81-124`) — **unhandled in Disco** (would fall to reduced nav). Functional gap.

## 4.6 Scheduling & availability
FM diner slots via **server endpoint** `GET /public-api/menuReference/{ref}/availableTime?date=` returning `{availableTime, available}[]`. **Disco computes CLIENT-SIDE** (`computeTimes`/`computeDates` in `RestaurantClient.tsx` from `scheduleOption`). Divergence — functional (diners may see slots FM would exclude). Menu-level `skippedDays` overrides not editable in Disco (§ 2.A). Restaurant closed-days built in Order Settings. Holiday calendar: the 12-13 system holidays in closed-days (built).

---

# Section 5 — Summary & recommended build order

## Counts (after Disco-side verification)
- Diner routes: 17. ~13 matches/ahead, 1 stub-missing (`/account/security`), 1 missing (city pages), 1 deferred (fullmap), 1 functional (scheduling).
- Restaurant routes: 16. **~13 matches** (Account/Profile, Banking, Tax Rate, Customers, Reports, Groups, Modifiers, Menus-list, Order-Settings, Links, Locations, Authorized-Users, Orders), **1 diverges (per-menu Settings § 2.A)**, dashboard partial (aggregate gate), + the shared drag-reorder gap on 3 pages.
- Admin routes: 14. ~9 matches, 3 stubs (match FM), 1 missing (Tax Config), 1 diverges (lead-gen).
- **Net**: far fewer real gaps than the first draft implied. The headline divergence is the per-menu Settings dialog (§ 2.A); almost everything else is matching or a small functional nit.

## Ranked FINANCIAL gaps
1. Per-menu **Delivery Fulfillment** not editable (own $/% primary+secondary + NASH `thirdPartyDeliverySubsidingPercent`) — § 2.A.
2. Per-menu **Tips & Surcharges** not editable — § 2.A.
3. **Lead-gen** shape diverges (payout withholding) — § 3.A.
4. Menu **category enum** wrong (marketplace placement) — § 2.A.
5. **deliveryType enum** wrong (`THIRD_PARTY` vs `NASH_DELIVERY`) — § 2.A.

## Ranked FUNCTIONAL gaps
1. Client-side scheduling vs FM `availableTime` — § 4.6 (wrong slots).
2. Menu Scheduling Override (skippedDays) not editable — § 2.A.
3. Admin order detail drawer + refund missing — § 3 / SA audit D.1.
4. Tax Configuration page missing (admin) — § 3.
5. `/account/security` change-password stub — § 1.9.
6. City `/locations/{url}` landing pages missing — § 1.17.
7. Drag-reorder missing on Menus list + Group Library + Modifier Library — § 2.B/2.C.
8. REGIONAL_ADMIN unhandled — § 4.5.

## Cosmetic-only
- Restaurant Customers export CSV vs FM Excel (§ 2.H).
- Tax Rate "Other" types as JSON textarea vs checkboxes (§ 2.G).

## Build order (sessions)

### Session A — Per-menu Settings: Delivery Fulfillment + Tips (financial, top priority). Est ~3h. Deps: none.
Deliverables:
- In `MenuSettingsDialog.tsx`, fix `deliveryType` type to `'OWN_DELIVERY' | 'NASH_DELIVERY'` and add a radio toggle.
- Add Self-Delivery block: `ownDeliveryRadius` (number, miles), primary fee with a **$/% toggle** wiring `ownDeliveryFee` (2dp) XOR `ownDeliveryFeePercent` (3dp); a secondary tier wiring `secondaryOwnDeliveryRadius` + `secondaryOwnDeliveryFee`/`Percent`.
- Add Third-Party block: `thirdPartyDeliverySubsidingPercent` (number; mirror FM's default-20-on-clear or flag).
- Add Tips & Surcharges block: preset pills 10/15/20 + Custom → `tipOption{tipsPrice,tipsType}`; `serviceCharge` (%) + `serviceChargeName`.
- Wire all into the existing save() `settings` object (stop relying on the `...menu.settings` spread for these).
Verification: open a menu, set own-delivery $5 primary / 10% secondary + 20% NASH subsidy + 15% tip + $ service charge, save, reload → values persist; PUT body matches the § 2.A payload shape.

### Session B — Per-menu Settings: category enum + Scheduling Override + Availability date-range. Est ~2h. Deps: A (same file).
Deliverables:
- Replace `MENU_TYPES` with FM's GENERAL_CATERING/OFFICE_CATERING/HOLIDAY_CATERING/MEAL_PREP/PRIVATE_CHEF/NATIONWIDE_SHIPPING/MERCH/POP_UP (after confirming open-question 1).
- Add Menu Availability default/custom + `startDate`/`endDate`.
- Add a Scheduling Override editor (skippedDays modal: name, date range, Closed-All-Day vs custom time window).
- Add "NO" cutoff option.
Verification: category round-trips; a blackout date appears in `skippedDays` payload.

### Session C — Scheduling parity. Est ~2h. Deps: none.
Deliverables: replace `computeTimes`/`computeDates` in `RestaurantClient.tsx` with `GET /public-api/menuReference/{ref}/availableTime?date=` (new proxy `app/api/fm-available-time`). Keep client compute as a fallback only.
Verification: a menu with a `skippedDays` blackout hides those slots; slots match FM exactly for a test date.

### Session D — Lead-gen + delivery-fee end-to-end verification. Est ~1.5h. Deps: A.
Deliverables: convert Disco lead-gen inputs to number(0-100)+defaults 15/3 matching FM; add cart tests for own-delivery $ vs % and the NASH subsidy now that § 2.A is editable; (open question 2) optionally add an edit-after-creation UI.
Verification: place a delivery order against a menu with own-delivery %; the cart delivery fee matches FM; lead-gen withholding reflected if a payout view exists.

### Session E — Admin order detail + refund + Tax Configuration. Est ~3h. Deps: none.
Deliverables: admin order detail drawer (mirror restaurant drawer) with refund (`PUT /api/admin/userOrders/{ref}/refund {amount}`); `/admin/tax-rate` page (`GET/PUT /api/restaurants/taxRate`, 3 tax rows, Other PICKUP/DELIVERY types) + sidebar item.
Verification: refund an admin order; edit a tax rate and reload.

### Session F — SA aggregate gate + REGIONAL_ADMIN + city pages + diner security. Est ~3h. Deps: none.
Deliverables: ship the SA aggregate-reporting gate removal (after live-verifying the aggregate endpoint); handle `REGIONAL_ADMIN` in sidebar/middleware (same nav as SA per `paths.constant.ts:81-124`); build `/locations/[url]` city pages (`GET /public-api/restaurants/links/{url}`, grouped-by-state); implement `/account/security` change-password (mirror the restaurant `POST /api/restaurant/change-password` already built).
Verification: a REGIONAL_ADMIN sees the SA nav; `/locations/new-york` renders grouped restaurants; a diner can change their password.

### Session G (low priority) — drag-reorder + small nits. Est ~2h.
Add CDK-style drag-reorder + `position` PUT to Menus list (`/api/menu/{ref}/position`), Group Library (`/api/extraItemsGroups/{ref}/position`), Modifier Library (`/api/addOns/{ref}/position`). Confirm `download`/`email` report actions (§ 2.I). Confirm order-settings boolean-inversion (§ 2.D). Optionally switch Customers export to Excel and Tax "Other" types to checkboxes. Confirm Group 50-item cap + min<max client validation.

## Open questions for the user
1. **Menu category** — confirm FM's per-menu `type` uses GENERAL_CATERING/… (Disco shows FAMILY_MEAL/…). Are `menuType` and `menuCategory` two distinct fields, or did Disco use a stale enum?
2. **Lead-gen** — FM has no edit-after-creation/platform config. Mirror FM (create-only), or add an edit UI (exceeds FM)?
3. **Third-party subsidy** — FM defaults `thirdPartyDeliverySubsidingPercent` to 20 when cleared but labels "0-15%". Mirror the 20 default, or treat 15 as a cap?
4. **City pages** — FM uses `/locations/{url}` (grouped-by-state via multi-unit links), not `/new-york`. Build that pattern, or Disco-specific city routes?
5. **Scheduling** — OK to add the `availableTime` server call (extra request per date selection) in Session C?
6. **REGIONAL_ADMIN** — wire now (exists in FM) or wait for Orca 3.1?
7. **`/account/security`** — FM has change-password; Disco's page is a stub. Build it (Session F)? (Endpoint shape already proven on the restaurant side.)
8. **Reorder / Make-recurring** — Disco is AHEAD of FM (FM has neither). Keep as Disco features (Orca), correct?
9. **Drag-reorder** — FM has it on Menus/Groups/Modifiers; Disco lacks it on all three. Priority, or leave for Session G?
