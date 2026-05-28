# FM Marketplace Visibility + SYSTEM_ADMIN Access Control — Audit

> Read-only audit, written 2026-05-27. Source of truth for the marketplace map source-of-truth question and the SYSTEM_ADMIN multi-location work (D.3 from `docs/fm-super-admin-audit.md`).
>
> **Two findings up front that change the spec's premise — see § 0.**

---

## Section 0 — TL;DR up front

### Finding 1: FM has NO separate `marketplace` boolean field

The spec premise — "FM has a `marketplace` toggle distinct from `blocked`" — is **incorrect against current FM source.** FM uses two mechanisms that together provide the behavior:

- **`type: 'ORDERING' | 'MARKETPLACE'`** — enum on the restaurant model, set at creation, **immutable** post-create. Determines which admin list a restaurant lives in and which explore-endpoint variant it appears on.
- **`blocked: boolean`** — single visibility toggle that hides everywhere (orders + map + direct URL).

There is no togglable boolean on a Marketplace restaurant that says "don't show on the map." If FM SUPER_ADMIN wants to hide a marketplace restaurant from the map but keep it orderable, they have no such control today.

**Source**: `_system/_models/restaurant.model.ts:17-35` (model definition) — boolean fields are `onlineOrderingAllowed`, `deliveryAllowed`, `deliveryOnly`, `enableMenuSearch`. No `marketplace`, no `isMarketplaceVisible`, no `hideFromMarketplace`, no `isPublished`. The `type` field is the discriminator.

**Implication for the spec**:

- **A.1, A.2** (add marketplace toggle column to admin portal): cannot mirror FM exactly — there is nothing to mirror. The `blocked` toggle column we already shipped (commit `8999da1`, D.2 fix) is the only visibility control FM has.
- **A.3** (map sources from FM marketplace flag): still doable. Filter the explore endpoint by `type=MARKETPLACE` instead of by a boolean. Direct URLs continue to work for both `ORDERING` and `MARKETPLACE` types regardless of map appearance.
- **Peter's framing about Test Kitchen**: Test Kitchen is `type: 'ORDERING'` (not `MARKETPLACE`). It never appears on the map by design — not because a flag is off, but because of its category. The "still orderable by direct URL but not on map" behavior is what FM does for every ORDERING-type restaurant.

### Finding 2: SYSTEM_ADMIN multi-location access control is back-end gated, not visible in Angular source

The security boundary lives in FM's backend (Java, presumably), not in the Angular client. Critical questions cannot be answered from the source we have access to:

- Does FM's `/api/system-admin/orders` server-side filter to a SYSTEM_ADMIN's assigned locations automatically based on JWT claims? **The Angular code sends no `restaurantReference` filter param** — so the answer is either (a) backend auto-filters by JWT, or (b) backend returns ALL orders. (a) is safe; (b) is a serious vulnerability that already exists in FM today, in which case Disco Cater can't make it worse.
- Does FM's `PUT /api/system-admin/restaurants/current?restaurantReference=X` reject the call when X is not in the SYSTEM_ADMIN's assigned set? **No visible check in Angular** — backend must enforce.

**Implication**: B.3 (SYSTEM_ADMIN multi-location runtime in restaurant portal) **cannot be safely built in this session** without confirming the backend behavior. Peter to verify by either:
- Inspecting FM backend code (Java?) for the JWT-claim-filter logic
- Running a live test: log in as a SYSTEM_ADMIN with location [A,B], manually `curl` the orders endpoint, attempt to GET orders for unassigned location C, confirm 401/403.

B.4 (the SUPER_ADMIN assignment editor) is buildable — the form shape + endpoint are clear from Angular source.

---

## Section 1 — FM marketplace + visibility model

### 1.1 Restaurant model boolean fields

Source: `_system/_models/restaurant.model.ts:17-35` (the `IRestaurant` interface) and the deployed admin endpoints.

```typescript
export interface IRestaurant {
  onlineOrderingAllowed?: boolean   // /onlineOrdering toggle on Order Settings
  deliveryAllowed?: boolean
  deliveryOnly?: boolean
  enableMenuSearch?: boolean
  type?: 'ORDERING' | 'MARKETPLACE' // category, set at creation, immutable
  // …other non-boolean fields…
}
```

`blocked` is not on the model interface but is returned by the admin API on each restaurant row. It's settable via `POST /api/admin/restaurants/manage/block/{ref}?block={bool}` (already wired in Disco Cater via `8999da1`).

### 1.2 Customer-facing explore endpoint

Source: `_system/_services/restaurant/restaurant.service.ts:32` and `pages/public/explore/explore.component.ts:123-127, 225-236`.

```
GET /public-api/restaurants/explore?type={ORDERING|MARKETPLACE}&page=&size=&sort=
```

The explore page calls **both** in parallel (`forkJoin`) — one for each `type`. The marketplace map on familymeal.com is the `type=MARKETPLACE` branch.

Response shape: paginated `{ content: IRestaurant[], totalElements, totalPages }`.

**[NEEDS REVIEW]** — whether the backend applies `blocked=false` server-side on the explore endpoint, or if the Angular client filters afterward. The Angular source doesn't show a client-side `blocked` filter on the explore page. Safe assumption: backend filters. Peter to confirm if marketplace map suddenly shows a blocked restaurant.

### 1.3 Direct slug lookup

Source: `_system/_services/restaurant/restaurant.service.ts:27, 205-207, 436-440` and `pages/public/checkout/checkout-pantry/checkout-pantry.component.ts:480-507`.

Two-step lookup:

```
1. GET /public-api/restaurants/business/{businessNameWithoutSpaces}
   → returns the restaurant with .reference
2. GET /public-api/restaurants/{reference}
   → returns full restaurant data (menus, settings, etc.)
```

The slug field on the restaurant model is **`businessNameWithoutSpaces`** (string).

**[NEEDS REVIEW]** — whether a `blocked=true` restaurant accessed by direct slug returns data or 404. Angular code makes no visibility check before rendering, so either:
- Backend returns the restaurant regardless (then the ordering flow would fail at a later step), OR
- Backend 404s for blocked restaurants (then the slug lookup fails fast).

This matters for our `/restaurants/[slug]` FM fallback. Test Kitchen is `type: ORDERING`, presumably `blocked: false` — direct URL must work.

---

## Section 2 — SYSTEM_ADMIN location assignment + filtering

### 2.1 The SUPER_ADMIN UpdateAdmin form (B.1)

Source: `admin/admin-management/update-admin/update-admin.component.html:38-44` and `.ts:54-59, 100, 106-107`.

UI: a Material `<mat-select multiple>` listing all restaurants as checkboxes.

Form field: **`restaurantReferences: string[]`** — array of restaurant UUID strings. Validators.required (at least one selection).

Existing assignments on edit: read from `data.user.managedRestaurants[].reference` — the backend embeds the assignment list under `managedRestaurants` on user-list responses.

Save endpoint:

```
POST /api/admin/users/system-admin                   (create)
PUT  /api/admin/users/system-admin/{reference}       (update)

Body: {
  firstName, lastName, email, phoneNumber,
  restaurantReferences: ['<uuid>', '<uuid>', …]
}
```

(Source: `_system/_services/user/user.service.ts:40-42, 52-54`.)

### 2.2 The runtime filtering flow (B.2) — security-sensitive

A SYSTEM_ADMIN's session works like this (Angular side):

1. Login response includes a single `restaurantReference` (not an array). Source: `_system/_models/account.model.ts:57-72`.
2. JWT decodes to a single `restaurant` claim. Source: `_system/_services/jwt/jwt.service.ts:46-52`.
3. After login, the client calls `GET /api/system-admin/restaurants/list` (`restaurant.service.ts:396-408`) to fetch the assigned-locations dropdown.
4. The dropdown selection writes to **`localStorage.selectedRestaurant`**.
5. `PUT /api/system-admin/restaurants/current?restaurantReference={ref}` updates server session state (`restaurant.service.ts:198-203`).
6. The orders page calls `GET /api/system-admin/orders` with NO restaurant filter param. Source: `_system/_services/order/order.service.ts:163-182`.
7. Dashboard sends `restaurantReference=` if selected, omits it otherwise — when omitted, FM apparently returns aggregate data per the explore agent. Source: `admin-manager/dashboard/dashboard.component.ts:170-178`.

**Critical questions, all marked `[NEEDS REVIEW]` against backend code**:

- Does `/api/system-admin/orders` server-side filter to JWT-assigned locations, or return everything? (Step 6 above has no client-side filter.)
- Does `PUT .../current?restaurantReference=X` reject X when X isn't in the assigned set?
- The JWT has a single `restaurant` claim but a SYSTEM_ADMIN has many locations — does the backend re-derive the list from a separate table on every request, or does it trust whatever location the client says is "current"?

The Angular client cannot answer these. They are backend concerns.

### 2.3 The "aggregate vs scope to one" question

FM's dashboard appears to have BOTH modes: it sends `restaurantReference` if one is selected, omits otherwise. So the SYSTEM_ADMIN dashboard does aggregate when no location is picked.

For the orders page, the explore agent found NO `restaurantReference` is ever sent — implying FM auto-filters server-side, or returns all assigned orders aggregated.

Peter's framing in the spec ("aggregated by default, switcher scopes to one") **matches what FM appears to do** for the dashboard. For orders, the lack of a filter param is consistent with "aggregate by default" — modulo the security question above.

---

## Section 3 — Disco Cater plan after this audit

### Section 3.1 — What changes in scope

| Spec item | Status |
|---|---|
| A.1 Confirm FM `marketplace` field | ✅ done — **no such field exists** |
| A.2 Mirror toggle in admin portal | ❌ N/A — nothing to mirror (`blocked` already shipped in D.2) |
| A.3 Fullmap sources from FM | Doable — filter by `type=MARKETPLACE`. **Deferred to its own session** (fullmap is 1300+ lines + tied to Sanity for cuisines/AI chat). |
| A.4 Sanity as enrichment | Same — depends on A.3. **Deferred**. Needs Sanity schema change too. |
| A.5 `/restaurants/[slug]` FM fallback | ✅ **landing this turn** |
| B.1 Audit UpdateAdmin shape | ✅ done in § 2.1 |
| B.2 Audit runtime filtering | ⚠ Angular side audited; **backend behavior is `[NEEDS REVIEW]`** |
| B.3 SYSTEM_ADMIN multi-location runtime | **Deferred — needs backend confirmation before safe to build** |
| B.4 SUPER_ADMIN assignment editor | ✅ **landing this turn** |
| B.5 ADMIN single-location verification | ✅ no code change needed; already correct |
| Part C verification checklist | Below in § 5 |

### Section 3.2 — Why A.3 / A.4 / B.3 are deferred

- **A.3 fullmap rewrite** — the customer fullmap has Mapbox markers, AI chat with restaurant context, cuisine pills, proximity filters, and full-text search, all currently tied to Sanity. Swapping data sources to FM and overlaying Sanity-as-enrichment is a 300+ line change with regression risk. Worth its own session with a careful before/after compare.
- **A.4 Sanity schema match** — requires adding `fmReference` to Sanity restaurant schema + writing a sync/mapping script. Schema changes in Sanity are user decisions, not mine to make unilaterally.
- **B.3 multi-location runtime** — until § 0 Finding 2 is resolved (backend access-control verification), building "show all assigned locations" in the restaurant portal could either be redundant (FM already does it) or unsafe (a SYSTEM_ADMIN sees data they shouldn't).

---

## Section 4 — Work landed in this turn

| ID | Change | File(s) |
|---|---|---|
| **A.5** | `/restaurants/[slug]` FM fallback when Sanity has no doc | `app/(customer)/restaurants/[slug]/page.tsx` |
| **A.5 proxy** | New `GET /api/fm-restaurant-by-slug/[slug]` proxy hitting `/public-api/restaurants/business/{slug}` | `app/api/fm-restaurant-by-slug/[slug]/route.ts` |
| **B.4** | SUPER_ADMIN location-assignment editor on manage-admins page | `app/(admin)/admin/(protected)/manage-admins/page.tsx` + new sibling `LocationAssignmentDialog.tsx` |
| **B.4 proxy** | New `PUT /api/admin/system-admins/[ref]/locations` (PUT body shape: `restaurantReferences: string[]`) | `app/api/admin/system-admins/[ref]/locations/route.ts` (extends existing route) |

See commit messages for FM source citations.

---

## Section 5 — Verification checklist for Peter

After Vercel deploys:

### A.5 — `/restaurants/[slug]` FM fallback
1. `https://www.discocater.com/restaurants/test-kitchen` (or another `ORDERING`-type FM restaurant with no Sanity doc) → page should render with FM data instead of 404.
2. Cart + checkout + `?debug=pricing` overlay should work identically.
3. `https://www.discocater.com/restaurants/some-marketplace-with-sanity-doc` → still loads from Sanity as before (no regression).

### B.4 — SUPER_ADMIN location assignment
1. Log in as `chef@familymeal.com` → `/admin/manage-admins`.
2. Click Edit on a SYSTEM_ADMIN row → location dialog opens with current assignments pre-checked.
3. Toggle some assignments → Save → success toast → close dialog.
4. Re-open the same SYSTEM_ADMIN row → assignments persist.
5. Network tab: confirm `PUT /api/admin/users/system-admin/{ref}` with `restaurantReferences: [...]` in body.

### What this audit deliberately doesn't verify

- The fullmap doesn't change in this session; map behavior is whatever it was before.
- Test Kitchen continues to NOT appear on the map (correct, it's `type: ORDERING`).
- The SYSTEM_ADMIN multi-location runtime in the restaurant portal is unchanged.

---

## Section 6 — Open questions for Peter

1. **The "marketplace toggle" you described**: Did you mean the existing `type: 'ORDERING' | 'MARKETPLACE'` enum (set at creation), or do you want Disco Cater to invent a new layer FM doesn't have? If you want FM to ship a new boolean field, that's a backend change — not in scope for Disco Cater.

2. **Backend SYSTEM_ADMIN filtering** — `/api/system-admin/orders` receives no restaurant filter param from the Angular client. Either FM auto-filters by JWT (safe) or returns all orders (vuln). Need a confirmation. Two ways:
   - Inspect FM backend code if you have access.
   - Run a live test: as a SYSTEM_ADMIN assigned to [A], try GET `/api/system-admin/orders` and see if it returns orders for unassigned restaurant B.

3. **`PUT /api/system-admin/restaurants/current?restaurantReference=X` validation** — does FM reject X when X isn't assigned? Quick test: set localStorage manually to a different restaurant ref, call the endpoint, see what FM returns.

4. **Sanity `fmReference` field** — do you want me to add this to the Sanity schema in a future session? It's required before A.4 (Sanity-as-enrichment) can land.

5. **Map data source switch (A.3)** — given the fullmap's size and feature density, would you prefer a phased approach? Phase 1: add FM as a fallback for restaurants Sanity doesn't have, sourced from `/public-api/restaurants/explore?type=MARKETPLACE`. Phase 2: full source-of-truth swap. Or do you want the full swap in one go in a dedicated session?
