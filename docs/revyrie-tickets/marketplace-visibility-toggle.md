# Revyrie Ticket — Marketplace Visibility Toggle

**Title:** Add a per-restaurant "show on catering marketplace" boolean, independent of `blocked`

**One-line summary:** FM needs a togglable `marketplaceVisible` field so a restaurant can be hidden from the public catering map while remaining orderable by direct URL — a capability the current data model can't express.

---

## Background & why

Disco Cater's catering map needs to show only the restaurants a platform admin has chosen to feature, while still allowing direct-link ordering for restaurants that aren't featured (e.g. test accounts, soft-launches, private clients).

FM's current restaurant model can't express this. Confirmed in source:

- `_system/_models/restaurant.model.ts:17-35` — the `IRestaurant` interface has `onlineOrderingAllowed`, `deliveryAllowed`, `deliveryOnly`, `enableMenuSearch`, and `type: 'ORDERING' | 'MARKETPLACE'`. **There is no `marketplaceVisible` / `showOnMarketplace` / `hideFromMarketplace` field.**
- Visibility today is controlled by two mechanisms, neither of which fits:
  1. `type: 'ORDERING' | 'MARKETPLACE'` — set at creation, **immutable**. Determines which admin list and which `/public-api/restaurants/explore?type=` branch a restaurant lives in.
  2. `blocked: boolean` — toggled via `POST /api/admin/restaurants/manage/block/{ref}?block={bool}` (`restaurant.service.ts:300-304`). But `blocked` hides the restaurant **everywhere** — map AND direct URL AND ordering. There's no "hide from map only" state.

So the gap: a MARKETPLACE-type restaurant is either fully visible (map + direct) or fully blocked (nowhere). No "orderable by link, hidden from map" state exists.

---

## Proposed field

```
marketplaceVisible: boolean   // default: true
```

- On the restaurant entity, alongside `blocked`.
- Default `true` so existing marketplace restaurants keep showing (no behavior change on migration).
- Semantics:
  - `marketplaceVisible === true` → appears in `/public-api/restaurants/explore?type=MARKETPLACE`
  - `marketplaceVisible === false` → omitted from explore results, but `GET /public-api/restaurants/business/{slug}` still resolves it (direct URL works)
  - `blocked === true` continues to override everything (hidden even from direct URL)

Effective visibility rule for the explore endpoint:
```
show on map  ⇔  type === 'MARKETPLACE' AND blocked === false AND marketplaceVisible === true
direct URL   ⇔  blocked === false   (marketplaceVisible irrelevant)
```

---

## Database migration

- Add `marketplace_visible BOOLEAN NOT NULL DEFAULT true` to the restaurants table.
- Backfill: all existing rows → `true` (preserves current behavior — every non-blocked marketplace restaurant stays visible).
- No data loss, no destructive change.

---

## New endpoint

Mirror the existing block-toggle pattern exactly:

```
PATCH /api/admin/restaurants/{ref}/marketplace-visible?visible={bool}
```

- Auth: SUPER_ADMIN only (same guard as the block endpoint).
- Returns: 200 + the updated restaurant, or the same void shape the block endpoint returns.
- Service method to mirror: `RestaurantService.blocked()` at `restaurant.service.ts:300-304` — clone it as `marketplaceVisible(reference, visible)`.

Explore endpoint change:
- `GET /public-api/restaurants/explore?type=MARKETPLACE` must filter `marketplaceVisible === true` server-side, in addition to the existing `blocked === false` filter.

---

## Acceptance criteria (QA)

1. New restaurant created as MARKETPLACE type → `marketplaceVisible` defaults to `true` → appears on the explore/map endpoint.
2. SUPER_ADMIN toggles `marketplaceVisible` to `false` via the PATCH endpoint → restaurant disappears from `/public-api/restaurants/explore?type=MARKETPLACE` within one cache cycle.
3. Same restaurant with `marketplaceVisible === false` → `GET /public-api/restaurants/business/{slug}` still returns it (direct URL ordering works).
4. Setting `blocked === true` → restaurant hidden from BOTH explore and direct URL regardless of `marketplaceVisible`.
5. Migration backfill: every pre-existing marketplace restaurant has `marketplaceVisible === true` and still shows on the map.
6. ORDERING-type restaurants are unaffected (the flag is only consulted on the MARKETPLACE explore branch).

---

## Estimated effort

Developer guess: **0.5–1 day.** It's a clone of the existing block-toggle pattern + a migration + one explore-query filter clause. The pattern already exists end-to-end (`blocked`), so this is low-novelty work.

---

## Disco Cater frontend changes that follow once shipped

1. Add a "Show on marketplace" toggle column to `app/(admin)/admin/(protected)/manage-restaurants/marketplace/page.tsx`, parallel to the existing `blocked` Visible toggle (which shipped in commit `8999da1`).
2. New proxy `app/api/admin/restaurants/[ref]/marketplace-visible/route.ts` (PATCH), mirroring the existing block proxy.
3. When the customer fullmap is migrated to source from FM (deferred A.3 in `docs/fm-marketplace-and-access-audit.md`), filter the explore list by `marketplaceVisible === true`.

Until this ships, Disco Cater uses `blocked` as the only visibility control and the catering map continues to source from Sanity (FM is direct-URL only via the A.5 fallback in `bc91d3a`).
