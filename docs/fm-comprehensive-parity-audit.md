# FM Comprehensive Parity Audit — All Three Login Types (field-level)

> Read-only master audit, 2026-05-27 (redone with field-level depth). Single index across diner, restaurant-portal, and admin-portal surfaces. Where a prior audit doc covers ground it is referenced by name + a one-paragraph delta of anything new found this pass. The four user-flagged priorities (per-menu Settings § 2.A, lead-gen § 3.A, third-party withholding § 2.A + § 4.1, fee logic § 4.1) get the deepest treatment.
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
- **Disco — split into THREE pages**: `/account/profile`, `/account/security`, `/account/addresses`.
- **Status**: **diverges (structural, functional)**. Disco split FM's one page into three. Not wrong financially, but the address page should confirm single-vs-multi (FM is single). Disco `addresses/page.tsx` reads structured address from `/api/fm-user`. `[NEEDS REVIEW]` — confirm Disco's address PUT hits `/api/users/addresses` not a different shape.
- **Gap**: Disco profile/security field-validation parity not confirmed this pass (functional).

## 1.12 — `/account/notifications`
- **FM**: **NO diner-side notification preferences UI exists** (NotificationService endpoints `/api/notifications`, `/api/orderSettings` exist but no diner component wired). **Disco**: HAS `/account/notifications`.
- **Status**: **ahead / `[NEEDS REVIEW]`**. Disco has a page FM lacks. Confirm what it writes to — if it PUTs `/api/notifications` it may collide with the RESTAURANT notification settings (that endpoint is restaurant-scoped). **Potential bug**: a diner-side page writing restaurant notification settings would be wrong. Flag for review.

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
| City `/locations/{url}` landing pages missing | functional |
| `/account/notifications` may write restaurant-scoped settings | `[NEEDS REVIEW]` functional |
| Profile/security/address split vs FM's single page | functional (cosmetic structural) |
| Fullmap not FM-sourced | functional (deferred) |

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
| 2.6 | `/restaurant/manage-v2/menus` (list) | SA+ADMIN | **partial — see § 2.B** | drag-reorder gap |
| 2.7 | `/restaurant/manage-v2/[menuRef]/settings` | SA+ADMIN | **DIVERGES — § 2.A** | the big one |
| 2.8 | `/restaurant/manage/groups` (Group Library) | SA+ADMIN | **partial — § 2.C** | min/max selection, clone, archive |
| 2.9 | `/restaurant/manage/modifiers` (Modifier Library) | SA+ADMIN | **partial — § 2.C** | |
| 2.10 | `/restaurant/order-settings` (Settings) | SA+ADMIN | matches | built `7c2b423`; full field list § 2.D |
| 2.11 | `/restaurant/account/profile` | ADMIN | partial — § 2.E | FM has 5 sub-forms |
| 2.12 | `/restaurant/account/banking` (Stripe Connect) | ADMIN | partial — § 2.F | |
| 2.13 | `/restaurant/tax-rate` | SA | partial — § 2.G | |
| 2.14 | `/restaurant/restaurant-customers` | SA+ADMIN | partial — § 2.H | |
| 2.15 | `/restaurant/manage/admin-manager-reports` (Reports) | SA | **partial — § 2.I** | FM has real scheduled-reports infra |
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
- **FM**: `menus-table.component.ts:29-187`. Columns: drag, menuName, menuType, startDate, endDate, image, settings, actions. **Drag-reorder** via `PUT /api/menu/{ref}/position?position={pos}` (index adjusted for pagination, `:178-184`). Kebab: clone (`POST /api/menu/{ref}/clone`), visible toggle (`PUT .../visible`), archive (`PUT .../archive`), delete. Tabs active/inactive/archived `[NEEDS REVIEW]` (filter by menuType param).
- **Disco**: `manage-v2/menus/page.tsx` — tabs + clone + visible + archive + delete + the "⚙ Menu Settings" pill.
- **Status**: partial. **Gap: drag-reorder not implemented** (no `position` PUT). Functional.

## 2.C — Group Library + Modifier Library
- **FM Group Library**: `admin/manage-menus/groups/`. Endpoints `POST/PUT/DELETE /api/extraItemsGroups`, `PUT .../{ref}/position`, `POST .../{ref}/clone`, `GET /api/restaurants/{ref}/extraItemsGroups`. Columns: drag, name, externalName, items(count), minSelectedItems, maxSelectedItems, actions. Form: `name`*, `externalName`*, `subExternalName`*, `minSelectedItems`*, `maxSelectedItems`*, `addOnsReferences[]`. Rules: max 50 items/group, min<max, archive sets visible=false.
- **FM Modifier Library**: `admin/manage-menus/add-ons/`. Endpoints `POST/PUT/DELETE /api/addOns`, position, clone, `GET /api/addOns`. Columns: drag, name, price, actions. Form: `name`*, `price`* (regex `^[0-9]*[.]?[0-9]*$`).
- **Disco**: `manage/groups/page.tsx`, `manage/modifiers/page.tsx` — exist.
- **Status**: partial — `[NEEDS REVIEW]`, not field-reconciled this pass. Need to verify min/max selection fields, externalName/subExternalName, drag-reorder, clone, 50-item cap.

## 2.D — Restaurant Order Settings (`/restaurant/order-settings`)
- **FM**: `admin/order-settings/order-settings.component.ts:105-134`. Built in Disco `7c2b423` and reconciled in earlier work. Field list (FM): `businessNameWithoutSpaces` (slug), `announcement` (≤500), `phone`, `email`*, `emailNotificationType` (ALL/ORDERS_ONLY/OFF), `phoneNotificationType`, `autoPrint` (inverted on save), `enableMenuSearch` (inverted), `orderReminderEmailsEnabled` (inverted), `deliveryOrderTimeWindows` ('exact'/range); online ordering toggle `PATCH /api/restaurants/onlineOrdering`; closed days `/api/closedDays`; coupon `/api/coupon`. Endpoints `/api/notifications`, `/api/feesAndTips`.
- **Disco**: built.
- **Status**: matches (per `7c2b423`). Delta: FM inverts `autoPrint`/`enableMenuSearch`/`orderReminderEmailsEnabled` booleans on save (`order-settings.component.ts:457-458,290,610`) — `[NEEDS REVIEW]` confirm Disco inverts identically or it'll toggle backwards.

## 2.E — Restaurant Account/Profile
- **FM**: `admin/account/profile/profile.component.ts:80-132`. FIVE forms: Profile (firstName*/lastName/email[disabled]/phone*), Business (businessLegalName/city/state/zipcode, `/api/businessInfo`), Address (businessName*/phone*/addressLine1*/lat/lng/timezone via Google), DoorDash (pickupInstructions ≤1000), Password (`POST /api/changePassword`), Images (restaurant 1:1 + marketplace 4:3, cropper, `/public-api/images`).
- **Disco**: `account/profile/page.tsx`.
- **Status**: partial — `[NEEDS REVIEW]`. Likely missing Business form, DoorDash pickup instructions, dual image upload, password change. Functional.

## 2.F — Banking / Stripe Connect
- **FM**: `admin/account/banking/banking.component.ts:18,44-106`. `HEAD /api/stripe/{ref}` (status), `POST /api/stripe/clients/{ref}/connect` (→ stripeConnectUrl), `GET /api/stripe/disconnect/{ref}`. Modal confirm → open Stripe URL.
- **Disco**: `account/banking/page.tsx` — connect flow present.
- **Status**: partial — not deeply reconciled.

## 2.G — Tax Rate
- **FM**: `admin/tax-rate/tax-rate.component.ts:16,36-58`. `GET/PUT /api/restaurants/taxRate`. 3 rows: State/Local/Other Sales Tax; each `fixedAmount` ($) + `percent` (%); Other has `types[]` (PICKUP/DELIVERY). Body keyed by tax key. Platform-level (no per-restaurant override).
- **Disco**: `restaurant/tax-rate/page.tsx`.
- **Status**: partial — `[NEEDS REVIEW]` confirm the 3-row state/local/other shape + Other's PICKUP/DELIVERY types.

## 2.H — Restaurant Customers
- **FM**: `admin/restaurant-customers/`. `GET /api/customer/users` (paginated, search), detail `GET /api/customer/users/{ref}/orders`. List columns: username, email, phoneNumber, numberOfOrders, totalspend. Excel export. Detail: order history (orderDate, orderCreatedDate, orderType, totalSpend).
- **Disco**: `restaurant-customers/page.tsx` + `[customerRef]/page.tsx`.
- **Status**: partial — `[NEEDS REVIEW]` confirm columns + Excel export + detail order history.

## 2.I — Reports (`/restaurant/manage/admin-manager-reports`)
- **FM**: `admin-manager/reports/` — REAL infra, not stub. Scheduled reports CRUD (`GET/POST/PUT/DELETE /api/reports/scheduled`), `GET /api/reports/columns`, `POST /api/reports/download`, `POST /api/reports/email`, `GET /api/reports/runs` (logs). Sub-components: scheduled-reports, create/update option, runs-log.
- **Disco**: `admin-manager-reports/page.tsx`.
- **Status**: partial — `[NEEDS REVIEW]`. FM has scheduled-report creation + email delivery + run logs; confirm Disco coverage. Functional. (Overlaps Project Orca 3.4 reporting.)

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
FM restaurant Order Settings: email mode (ALL/ORDERS_ONLY/OFF) + recipients, text notifications + recipients, customer/restaurant reminder toggles, print kitchen tickets, enable menu search, delivery time windows, announcement (≤500). Built in Disco (`7c2b423`). **No admin email-template editor in FM** (SA audit E.6). **No diner-side notification UI in FM** — but Disco HAS `/account/notifications` (§ 1.12) — confirm it doesn't write restaurant-scoped settings. SMS/text via the restaurant phone recipients array. In-app notifications: none in FM.

## 4.3 Reporting / analytics
Restaurant dashboard ~20 cards + SA dashboard built. SA aggregates by default (`fm-multi-location-runtime-audit.md`). FM has **scheduled-reports infra** (§ 2.I — create/email/download/runs) NOT yet built in Disco. Custom report builder + scheduling = Project Orca 3.4 (partly exists in FM's reports module). Export: per-page CSV (admin Customers) + Excel (restaurant Customers).

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

## Counts
- Diner routes: 17. ~9 matches/ahead, ~5 partial, 1 missing (city pages), 1 review (notifications).
- Restaurant routes: 16. ~6 matches, ~9 partial, **1 diverges (per-menu Settings)**.
- Admin routes: 14. ~9 matches, 3 stubs (match FM), 1 missing (Tax Config), 1 diverges (lead-gen).
- Cross-cutting gaps: per-menu fee editing, lead-gen shape, client-side scheduling, REGIONAL_ADMIN, scheduled reports, diner notifications review.

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
5. City `/locations/{url}` landing pages missing — § 1.17.
6. Manage Menus drag-reorder missing — § 2.B.
7. REGIONAL_ADMIN unhandled — § 4.5.
8. Reports scheduled-report infra — § 2.I.
9. `/account/notifications` scope review — § 1.12.

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

### Session F — Reporting Track 2 + REGIONAL_ADMIN + city pages. Est ~3h. Deps: none.
Deliverables: ship the SA aggregate-reporting gate removal (after live-verifying the aggregate endpoint); handle `REGIONAL_ADMIN` in sidebar/middleware (same nav as SA per `paths.constant.ts:81-124`); build `/locations/[url]` city pages (`GET /public-api/restaurants/links/{url}`, grouped-by-state).
Verification: a REGIONAL_ADMIN sees the SA nav; `/locations/new-york` renders grouped restaurants.

### Session G (later) — partial-page reconciliation. Est ~2-3h. Lower priority.
Group/Modifier Library field reconciliation (min/max selection, externalName, drag, clone, 50-cap); restaurant Account profile 5-form parity; restaurant Customers columns + Excel; Reports scheduled-report infra; Manage Menus drag-reorder; diner notifications scope review; diner profile/security/address parity; order-settings boolean-inversion check.

## Open questions for the user
1. **Menu category** — confirm FM's per-menu `type` uses GENERAL_CATERING/… (Disco shows FAMILY_MEAL/…). Are `menuType` and `menuCategory` two distinct fields, or did Disco use a stale enum?
2. **Lead-gen** — FM has no edit-after-creation/platform config. Mirror FM (create-only), or add an edit UI (exceeds FM)?
3. **Third-party subsidy** — FM defaults `thirdPartyDeliverySubsidingPercent` to 20 when cleared but labels "0-15%". Mirror the 20 default, or treat 15 as a cap?
4. **City pages** — FM uses `/locations/{url}` (grouped-by-state via multi-unit links), not `/new-york`. Build that pattern, or Disco-specific city routes?
5. **Scheduling** — OK to add the `availableTime` server call (extra request per date selection) in Session C?
6. **REGIONAL_ADMIN** — wire now (exists in FM) or wait for Orca 3.1?
7. **`/account/notifications`** — Disco has a diner page FM lacks; confirm it isn't writing restaurant-scoped `/api/notifications`. Keep, fix, or remove?
8. **Reorder / Make-recurring** — Disco is AHEAD of FM (FM has neither). Keep as Disco features (Orca), correct?
