# FM SUPER_ADMIN Portal — Gap Analysis (Disco Cater)

> Read-only audit, written 2026-05-27. Source of truth for the SUPER_ADMIN admin portal under `app/(admin)/` and proxies under `app/api/admin/`.
>
> **Companion to `docs/fm-admin-portal-audit.md`** (the from-source FM audit, May 25). This doc does NOT duplicate that one — it points to it for everything already covered and only fills in the gaps surfaced by inventorying the Disco Cater build and re-spelunking FM source for features that audit didn't reach.
>
> **Mirror FM exactly.** Any divergence flagged here is a divergence to fix, not a feature decision to make.

---

## Section A — What's already documented

Every FM SUPER_ADMIN page has a corresponding section in `fm-admin-portal-audit.md`. **Read that file first.** The mapping below is the reading list — do not duplicate the content in this doc.

| FM page | FM route | Documented at |
|---|---|---|
| Auth model + JWT shape | `/admin` entry | `fm-admin-portal-audit.md` § 1 (lines 9–33) |
| Sidebar order + paths | n/a | § 2 (lines 35–51) |
| Route → component map | n/a | § 3 (lines 54–73) |
| All SUPER_ADMIN endpoint catalog | various | § 4 (lines 76–134) |
| Dashboard | `/admin/dashboard` | § 5.1 (lines 139–141) |
| Orders | `/admin/manage-orders` | § 5.2 (lines 143–166) |
| Content Management | `/admin/content-management` | § 5.3 (lines 168–180) |
| Users (diners) | `/admin/manage-users` | § 5.4 (lines 182–201) |
| Customers | `/admin/manage-customers` | § 5.5 (lines 203–206) |
| System Admins | `/admin/manage-admins` | § 5.6 (lines 208–222) |
| Restaurants — Ordering | `/admin/manage-restaurants/ordering` | § 5.7 (lines 224–254) |
| Restaurants — Marketplace | `/admin/manage-restaurants/marketplace` | § 5.8 (lines 256–257) |
| Bulk Menu Import | `/admin/manage-restaurants/bulk-import-menu` | § 5.9 (lines 259–263) |
| Menus (global, stub) | `/admin/manage-menus` | § 5.10 (lines 265–266) |
| Banking (Coming Soon) | `/admin/manage-banking` | § 5.11 (lines 268–270) |
| Settings (Coming Soon) | `/admin/manage-settings` | § 5.11 (lines 268–270) |
| Role capability matrix | n/a | § 6 (lines 274–291) |
| Conventions (pagination, images, toasts) | n/a | § 7 (lines 295–303) |

The existing audit also flags its own gaps in § 8 and recommends a build order in § 9 — both still accurate as of this audit.

---

## Section B — Documented in FM audit but not surfaced in Disco Cater UI

Endpoints catalogued in `fm-admin-portal-audit.md` § 4 whose Disco Cater proxy exists but has no UI wired to it.

| Endpoint | Proxy file | Why orphaned |
|---|---|---|
| `PUT /api/admin/userOrders/{ref}/refund` | `app/api/admin/orders/[ref]/refund/route.ts` | Orders table has no refund action. FM's `admin-orders-table` exposes refund per row via a kebab menu — we're missing it. |
| `GET / PUT / DELETE /api/admin/userOrders/{ref}` | `app/api/admin/orders/[ref]/route.ts` | Disco Cater has no order detail drawer in the admin Orders page (the restaurant-portal Orders page does). FM's admin-orders does open a detail dialog. |
| `GET / PUT / DELETE /api/admin/restaurants/{ref}` | `app/api/admin/restaurants/[ref]/route.ts` | No restaurant detail / edit page on the admin side; we only have list + inline toggles. FM has `UpdateRestaurantComponent` for full edits. |
| `POST /api/admin/users` (create user) | `app/api/admin/users/route.ts` POST handler | The users page only lists / disables / deletes; no "Create user" modal. FM's user-management does support it. |

None of these are pages — they're feature gaps on existing pages. Track them in Section D.

---

## Section C — Built in Disco Cater but not yet documented

Every Disco Cater admin page maps to a section in `fm-admin-portal-audit.md`. The inventory found **no Disco-Cater-only admin pages** without a corresponding FM section. So this section is intentionally empty.

If you add a page later that has no FM counterpart (e.g. a Disco-only Regional Admin page per Orca 3.1), document it here first.

---

## Section D — Built but diverges from FM

Pages that exist in Disco Cater but don't match the FM behavior captured in `fm-admin-portal-audit.md` § 5 or this doc's Section E. Severity is from the user's perspective.

### D.1 Orders (`/admin/manage-orders`) — functional severity

- **Missing**: Refund action per order. FM exposes refund via the kebab menu in `admin-orders-table.component.ts`. Disco Cater inlines only the status dropdown.
- **Missing**: Order detail drawer / dialog. FM opens a full detail on row click. Disco Cater has none — the proxy exists (`/api/admin/orders/{ref}` GET) but no UI.
- **Cosmetic**: Nash ETA columns (`nashDeliveryPickupEta`, `nashDeliveryDropoffEta`) are parsed off the response but never displayed.

### D.2 Restaurants — Marketplace (`/admin/manage-restaurants/marketplace`) — functional severity

- **Missing**: Block toggle on each row. FM's restaurant-table renders the same `blocked` checkbox column on both Ordering and Marketplace lists. Disco Cater's Marketplace page is read-only.
- **Missing**: Edit / "view restaurant" action. FM has it via the table's action menu.

### D.3 System Admins (`/admin/manage-admins`) — functional severity

- **Missing**: Multi-location assignment. FM's `UpdateAdminComponent` lets the SUPER_ADMIN assign a SYSTEM_ADMIN to a specific subset of restaurants (the `locations` column on the table shows a count). Disco Cater shows the count but doesn't let you edit it.
- **[NEEDS REVIEW]**: Exact field shape for the location-assignment payload — `fm-admin-portal-audit.md` § 5.6 notes this as a known gap (§ 8.4). Read FM source for `UpdateAdminComponent` before building.

### D.4 Login (`/admin/login`) — cosmetic severity

- Session is persisted only to client localStorage (`admin_user`). FM uses the same `currentUser` pattern, so this matches behavior — but the audit notes "no backend session check". Verify on first build phase that the cookie + middleware path still works for SUPER_ADMIN identically to ADMIN. The middleware at `middleware.ts:42` does enforce `role !== 'SUPER_ADMIN'` → redirect, which is correct.

### D.5 Restaurants — Ordering (`/admin/manage-restaurants/ordering`) — partial

- **Missing**: "Add Restaurant" form. The proxy POST `/api/admin/restaurants` exists (multipart with restaurant blob + optional menu CSV) but no UI. FM has `admin/restaurant/update/add-restaurant/add-restaurant.component.ts` with the full form spec'd in `fm-admin-portal-audit.md` § 5.7 lines 250–254.

### D.6 Dashboard — partial

- The existing audit § 8.1 flags `DashboardService` endpoints as not fully traced. Disco Cater's `app/(admin)/admin/(protected)/dashboard/page.tsx` is functional today against `/api/admin/dashboard/{stats,sale-stats}`, but the FM-side endpoint mapping ("statistics" vs "stats", "sale/statistics" vs "sale/stats") should be re-verified during the build phase since FM uses different paths between SA portal (`/api/admin/dashboard/sale/statistics`) and the per-restaurant Reporting page (`/api/system-admin/dashboard/sale/stats`) per the explore done in earlier sessions.

---

## Section E — SUPER_ADMIN features that need a fresh FM source audit

For each page in the user's original 15-item list that isn't in `fm-admin-portal-audit.md`, here is the FM-source spec from this session's spelunk. Build phase mirrors these exactly.

### E.1 Tax Configuration (platform-level)

**FM exists. Disco Cater missing.**

- **FM route**: `/admin/tax-rate`
- **FM component**: `admin/tax-rate/tax-rate.component.ts:32-64`
- **Role visibility**: SUPER_ADMIN only (verified via route guard pattern matching the rest of `/admin/*`)
- **Sidebar position**: Not in the canonical 10-item sidebar list in `fm-admin-portal-audit.md` § 2. **[NEEDS REVIEW]**: confirm whether FM exposes Tax Rate as a top-level sidebar item or only via a deep link from another page.
- **Purpose**: Configure the platform-wide default sales-tax rates (state, local, other). No per-restaurant override.

**Layout**: Table with columns `[title, percent, currency, actions]`. Edit opens `UpdateTaxRateComponent` dialog. Footer shows aggregate totals (sum of fixed amounts + sum of percents).

**Fields displayed**:
- `stateSalesTax.fixedAmount` (number) / `stateSalesTax.percent` (number)
- `localSalesTax.fixedAmount` (number) / `localSalesTax.percent` (number)
- `otherSalesTax.fixedAmount` (number) / `otherSalesTax.percent` (number) / `otherSalesTax.types` (string[])

**Actions**:
- Edit row → opens dialog → PUT updated tax rate
- No add/delete (the three categories are fixed)

**API endpoints**:
- `GET /api/restaurants/taxRate` → `{ stateSalesTax, localSalesTax, otherSalesTax }`
- `PUT /api/restaurants/taxRate` → same shape as GET response

**Role gating differences**: Single role (SUPER_ADMIN). No Regional Admin equivalent.

**Business rules**: None surfaced from source. The same endpoint is consumed by `_system/_services/restaurant/restaurant.service.ts:424-434` for both read and write.

**Notes**: This is a platform-wide default, not per-restaurant. Restaurant Settings does NOT have a tax override (verified in the restaurant-portal audit). [NEEDS REVIEW] for whether FM SUPER_ADMIN can override per restaurant — current evidence says no.

### E.2 Coupons / Promo Codes (platform-level)

**FM does NOT ship a platform-level coupons page.** Per-restaurant coupons only.

- Endpoints `/api/coupon` (GET / POST / PUT / DELETE) live in `_system/_services/order-settings/order-settings.service.ts`.
- Each restaurant configures one coupon via Order Settings (covered in `fm-restaurant-portal-audit.md` and the existing `app/(restaurant)/restaurant/(portal)/order-settings/page.tsx`).
- Field shape: `{ code, maxAvailable, maxPerDiner, discountPercentage, startDate, endDate }`.
- SUPER_ADMIN has no centralized coupon dashboard in FM.

**Disco Cater build implication**: do not add a `/admin/coupons` page until/unless we decide to extend FM. Per the "mirror FM exactly" rule, this is green-field — skip.

### E.3 Delivery Providers

**FM has per-restaurant toggles only. No platform-config page.**

Existing FM endpoints (already in `fm-admin-portal-audit.md` § 4):
- `PATCH /api/admin/restaurants/{ref}/nashAllowed?nashAllowed={bool}`
- `PATCH /api/admin/restaurants/{ref}/shipdayEnabled?shipdayEnabled={bool}`

Surfaced as the `nash` and `shipdayEnabled` checkboxes on the Ordering Restaurants table (Disco Cater has these — wired and working).

DoorDash configuration is commented out in `restaurant.service.ts:306-310` — **dead code in FM**. Do not surface a DoorDash toggle in Disco Cater.

No SUPER_ADMIN page for global Nash / Shipday / DoorDash credentials exists in FM. Build implication: skip.

### E.4 Payouts / Stripe Connect (SUPER_ADMIN view)

**FM ships a Coming Soon stub.** `admin/admin-banking/admin-banking.component.ts` is 3 lines, renders `<app-coming-soon>`. No payout endpoints exist.

Disco Cater's `app/(admin)/admin/(protected)/manage-banking/page.tsx` is a matching stub — **on parity with FM**.

Build implication: leave as-is until FM ships payouts.

### E.5 Email Templates

**Does not exist in FM.** Grep across the FM source for `email-template`, `notification-template`, `template-editor` returns zero results. `NotificationService` exists but has no template CRUD endpoints.

Build implication: green-field, skip.

### E.6 Audit Log / Activity History

**Does not exist in FM.** `_system/_services/activity-tracker/activity-tracker.service.ts` is client-side session-timeout tracking only — not a server-side audit log.

Build implication: green-field, skip. If Orca 3.1 (Regional Admin) requires audit trails in a future phase, we'll spec it separately.

### E.7 Platform Settings / Feature Flags

**FM ships a Coming Soon stub** (`admin/admin-settings/admin-settings.component.ts`, 4 lines, renders `<app-coming-soon>`). No platform settings or feature flags exposed.

Disco Cater's `manage-settings/page.tsx` is a matching stub — on parity. Leave as-is.

### E.8 Regional Admin Management (per Orca 3.1)

**Does not exist in FM.** Grep for `REGIONAL_ADMIN`, `regional-admin`, `RegionalAdmin` across `/src/app/` returns zero results. FM has three roles only: `SUPER_ADMIN`, `SYSTEM_ADMIN`, `ADMIN`.

Build implication: per Orca 3.1, this is a Disco Cater greenfield feature requiring a new role + new endpoints. Per the rules of this session ("If you find something missing from FM, document the absence — do NOT design what we'd build instead"), nothing further to spec.

### E.9 Global Menu Management (per Orca 3.2)

**Does not exist in FM.** Grep for `globalMenu`, `master-menu`, `chain-menu`, `template-menu` returns zero. FM's `admin-menus` component is empty.

Disco Cater's `app/(admin)/admin/(protected)/manage-menus/page.tsx` is a stub explaining this — on parity. Leave as-is.

Per Orca 3.2 spec, full greenfield build. Don't design here.

### E.10 Updated Reporting & Analytics (per Orca 3.4)

**FM ships the read-only dashboard.** Disco Cater mirrors it. No custom report builder, no scheduling, no CSV/PDF export beyond the basic per-page CSV in Customers.

Build implication for Orca 3.4: green-field for the scheduler + report builder. The existing dashboard endpoints are reusable; the report-builder UI and the scheduled-email infrastructure are new.

### E.11 "Hide from Marketplace" toggle (the original missing-restaurant question)

**FM uses a single `blocked` boolean — there is no separate marketplace-visibility flag.** A restaurant created with `type = MARKETPLACE` shows in the marketplace list; setting `blocked = true` removes it from customer view. There is no "isPublished" or "isHidden" flag.

- Endpoint: `POST /api/admin/restaurants/manage/block/{ref}?block={bool}` (already in audit § 4)
- Customer-side: `GET /public-api/restaurants/explore?type={type}` applies `blocked=false` server-side.

Disco Cater divergence: the Marketplace list page does not surface this toggle (see Section D.2). Per the missing-restaurant diagnosis from the prior session, this is the actual flag we suspected — confirmed.

---

## Section F — Recurring gotchas for the build phase

Captured here so each subsequent build session doesn't have to re-derive them.

### F.1 JWT format
**Raw `Authorization: <token>`. NEVER `Bearer <token>`.** Confirmed at:
- FM source: `_system/_interceptor/jwt/jwt.interceptor.ts:28-38` (raw, see audit § 1)
- Disco Cater: `lib/restaurant-auth.ts` `getRestaurantAuthHeader()` returns `{ Authorization: token }`; admin equivalent in `lib/admin-auth.ts` (verify on first build).

Any new admin proxy must follow this. A `Bearer ` prefix produces opaque 401s from FM.

### F.2 Pagination
- Query params: `page` (0-based, omitted when 0 to mirror FM's `createRequestOption` helper), `size` (25/50/100/250), `sort` (array, repeated key per entry).
- Response: `{ content, totalElements, totalPages }`.
- LocalStorage key for user's last-chosen page size: `currentPaginationSize` (FM convention, optional in Disco Cater).
- **Cursor**: none. Page-based only.

### F.3 Restaurant types are TWO separate lists
- `type: 'ORDERING'` lives under `/api/admin/restaurants?restaurantStatus={status}` — full table with Nash, Shipday, holdPayments, etc.
- `type: 'MARKETPLACE'` lives under `/api/admin/restaurants/marketplace` — reduced field set (no Stripe Connect, no order-flow toggles).
- A restaurant cannot switch types post-creation per FM source.

### F.4 "Hide from marketplace" is the `blocked` flag
There is no `isPublished` or `hideFromMarketplace` field. Setting `blocked = true` removes the restaurant from `/public-api/restaurants/explore` results server-side. This is what explained the "Test Restaurant doesn't show" question from the prior session — see `docs/missing-restaurant-diagnosis.md`.

### F.5 Image upload is multipart through `/public-api/images`
- Upload: `POST /public-api/images` (multipart, file field). Response includes `reference`.
- Download: `GET /public-api/images/{ref}/download?size=300`.
- The Content Management page swaps `pending:` markers with real refs on save — replicate the pattern for any new image-upload UI.

### F.6 External bulk-import service has a hardcoded API key
- Host: `https://menuuploadstg.familymeal.com`
- Header: `x-api-key: dd1c0019-8742-46dc-845d-096f074d84e7`
- Do not expose this key client-side — proxy via `/api/admin/bulk-import/*` only.

### F.7 Status enums (memorize these)
- Restaurant status: `ACTIVE | INACTIVE | SUSPENDED | ARCHIVED`
- Order status: per `fm-admin-portal-audit.md` § 5.2
- Order type: `DELIVERY | PICKUP`
- Restaurant type: `ORDERING | MARKETPLACE`

### F.8 SUPER_ADMIN does NOT use the per-restaurant cookie
Unlike SYSTEM_ADMIN's `fm_selected_restaurant` cookie + `setCurrentRestaurant` session flow, SUPER_ADMIN calls each endpoint with an explicit `restaurantReference` query param when scoping is needed (e.g. `/api/admin/userOrders/{ref}?restaurantReference={r}`). The restaurant-portal cookie path is irrelevant on the SUPER_ADMIN side.

---

## Section G — Summary

### Counts

1. **Total FM SUPER_ADMIN pages** found across both audits: **13** (10 sidebar items + 3 stubs documented as Coming Soon by FM = Banking, Settings, Menus).
2. **Already built in Disco Cater and matching FM** (parity, including stubs): **12** (Dashboard, Orders, Content Management, Users, Customers, System Admins, Restaurants-Ordering, Restaurants-Marketplace, Bulk Import, Bulk Import Detail, plus Menus/Banking/Settings as stubs).
3. **Built in Disco Cater but diverging from FM** (functional severity): **5**
   - D.1 Orders — missing refund + detail drawer + Nash ETA columns
   - D.2 Restaurants Marketplace — missing block toggle + edit
   - D.3 System Admins — missing multi-location assignment
   - D.5 Restaurants Ordering — missing Add Restaurant form
   - D.6 Dashboard — endpoint mapping needs re-verification
4. **Documented but no UI wired** (orphaned proxies, Section B): **4 endpoints**.
5. **In FM but not yet documented + not yet built** (Section E): **1 page** — Tax Configuration (`/admin/tax-rate`).
6. **Spec'd in Orca but green-field** (FM has not built it; Disco Cater would be from-scratch): **3** — Regional Admin (3.1), Global Menus (3.2), Reporting Scheduler (3.4).
7. **Spec'd in user's original list 1–15 that do NOT exist in FM at all**: **4** — Email Templates, Audit Log, Platform-wide Coupons, Platform-wide Delivery Provider Config.

### Recommended build order

Mirror exactly, smallest first. Each row is one PR-sized chunk.

1. **Marketplace block toggle (D.2)** — one-line fix; surfaces the missing-Test-Restaurant resolution. The block proxy is wired; add the checkbox column.
2. **Add Restaurant form (D.5)** — unblocks SUPER_ADMIN onboarding workflows; spec is in audit § 5.7. Multipart POST `/api/admin/restaurants` with restaurant blob + optional menu CSV.
3. **Order detail drawer + refund (D.1)** — proxies exist; needs UI + plug into the table's row-click and kebab menu.
4. **Tax Configuration page (E.1)** — green-field for Disco Cater but FM-spec'd; new file `app/(admin)/admin/(protected)/tax-rate/page.tsx`, new proxy `app/api/admin/tax-rate/route.ts` GET + PUT.
5. **System Admin multi-location assignment (D.3)** — read `UpdateAdminComponent` from FM source first ([NEEDS REVIEW] flag in D.3); then build the picker.
6. **Re-verify Dashboard endpoint mapping (D.6)** — confirm `admin/dashboard/statistics` vs the alternates; strip the diagnostic console logs from the last reporting session once happy.
7. **Add User modal (Section B item)** — POST `/api/admin/users`; less-used; defer unless requested.

Everything in Section E.2 / E.4 / E.5 / E.6 / E.7 / E.8 / E.9 / E.10 is either an FM no-op (mirror the stub) or a green-field Orca phase 2 item — do not build until Peter confirms.

### Open questions for Peter

1. **Tax Configuration sidebar slot** — should `/admin/tax-rate` be the 11th sidebar item in Disco Cater (FM may have it as a top-level item; the canonical 10-item sidebar in `fm-admin-portal-audit.md` § 2 does not list it, which suggests FM accesses it via a different route, e.g. deep link from a per-restaurant page). [NEEDS REVIEW].
2. **System Admin location assignment payload** — `UpdateAdminComponent` field shape was flagged as a known gap (audit § 8.4). Confirm the payload before D.3 is built.
3. **Refund modal copy / business rules** — `PUT /api/admin/userOrders/{ref}/refund` accepts `{amount}`. Should the modal default to `total - refundAlready` (full remaining) and require a reason? FM's source flow [NEEDS REVIEW].
4. **Dashboard endpoint canonical naming** — `statistics` vs `stats`, `sale/statistics` vs `sale/stats`. Earlier sessions found one casing returned 400. Confirm which is the SA endpoint definitively before the D.6 fix.
5. **Marketplace edit page** — FM's marketplace list has an Edit action that opens the same `UpdateRestaurantComponent`. Should Disco Cater build a unified Edit Restaurant page that serves both Ordering and Marketplace types, or two separate pages? FM uses one component conditionally — recommend matching that pattern but flagging here.
6. **Bulk import API key rotation** — `dd1c0019-8742-46dc-845d-096f074d84e7` is hardcoded in FM source. Should we move it to an env var on the Disco Cater side? (Recommended yes, but it's still proxied so client never sees it; defer if low priority.)

### What this audit deliberately does NOT do

- It does not redesign or invent Disco-Cater-only features.
- It does not propose new FM endpoints. Anything missing from FM stays missing.
- It does not modify any app code or proxy. The next session does that.
- For green-field Orca items, it points at the scope doc and stops.
