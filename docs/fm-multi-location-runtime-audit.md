# FM Multi-Location Runtime — Orders + Reporting (Tracks 1 & 2)

> Written 2026-05-27. Source of truth for the SYSTEM_ADMIN multi-location Orders + Reporting runtime in the restaurant portal. Also captures the Track 3 (default menu) and Track 4 (sticky header) findings from the same session.

---

## Track 1 — Orders aggregation (BUILT)

### FM behavior (source)
- FM's `admin-manager-orders` shows orders **aggregated across all the SA's assigned locations by default** on first load — no location pick required.
- Endpoint: `GET /api/system-admin/orders` via `getOrdersBySystem()` (`order.service.ts:163-182`). **No `restaurantReference` param** — FM auto-filters by JWT.
- The table has a **`restaurantName` column** (`orders-table.component.html:39`) so the SA sees which location each order belongs to.
- Location scoping is via the `fm_selected_restaurant` session, not a per-request param. When a SA picks a location, FM's session scopes and the per-restaurant `/api/orders` returns that one location.

### What landed
**Proxy** (`app/api/restaurant/orders/route.ts`): role + selected-cookie aware. `(SYSTEM_ADMIN | SUPER_ADMIN) && !fm_selected_restaurant` → `GET /api/system-admin/orders` (aggregated). Otherwise → `GET /api/orders` (ADMIN single, or SA-with-selection scoped by FM session). **Additive** — only the previously-empty SA-no-selection case changes endpoint; ADMIN and SA-selected paths are byte-for-byte unchanged.

**Page** (`orders/page.tsx`):
- The old "Select a location to view orders" blocking prompt is replaced. SA-no-selection now loads aggregated orders.
- An info banner ("Showing orders across all your locations. Pick a location from the Reporting dropdown to scope to one.") shows in aggregating mode.
- A **Restaurant column** is added to the table (header + cell + colSpan bumps), rendered only when `aggregating`. Reads `order.restaurantName` from the aggregated response.
- ADMIN role: no banner, no Restaurant column, single-location orders exactly as before.

### Risk assessment
Low. The change only affects the SA-no-selection case, which previously showed an empty prompt (broken). Worst case if `/api/system-admin/orders` returns an unexpected shape: the aggregated view looks wrong — but ADMIN (the common case) and SA-with-selection are untouched. **Needs live verification** that the aggregated response carries `restaurantName` and the expected Order fields.

---

## Track 2 — Reporting aggregation (DOCUMENTED, NOT shipped — regression risk)

### FM behavior (source)
- FM's `admin-manager/dashboard` **aggregates by default** — the restaurant dropdown defaults to "All restaurants" (`restaurantReference: null`), and the sale-stats call fires on mount with no ref → `GET /api/system-admin/dashboard/sale/stats` aggregate (`dashboard.component.ts:76-85, 107-109, 140-178`).
- Picking a location patches `restaurantReference` and re-fires with the ref.
- **No tabs** — single metrics view (no per-tab location scoping to worry about).

### Current Disco Cater state
The dashboard (`dashboard/page.tsx`) **gates SA on `isSystemAdmin && !selectedRef`** — shows "Select a restaurant to generate a report" and disables Generate Report until a location is picked (lines 166, 310, 330). This diverges from FM's aggregate-by-default.

### Why NOT shipped this session
This gate was the resolution of a multi-session "$0.00 reporting" debugging saga. The per-restaurant path (with ref) is confirmed working; the **aggregate path (no ref) was never confirmed to return non-zero data** — the gate sidestepped it. Removing the gate would:
- Match FM (good), BUT
- Expose the unverified aggregate sale-stats path as the DEFAULT view on a previously-fragile page I can't test.
- If the aggregate endpoint returns $0 or 400s, the SA sees a broken reporting page by default — a **regression** from the current "pick → see data" working state.

Unlike Track 1 (which only changed a broken case), Track 2's gate is a working case. Different risk profile → held back pending live verification.

### Exact change when ready (one-liner)
In `dashboard/page.tsx`:
- Remove the `if (isSystemAdmin && !selectedRef) { setSaleStats({}); return }` early-return in `loadSaleStats` (line ~166).
- Remove the `disabled={isSystemAdmin && !selectedRef}` on the Generate Report button (line 310).
- Replace the "Select a restaurant" gate block (line 330) with an "All locations" info banner mirroring Track 1's.
- The proxy (`app/api/restaurant/dashboard/sale-stats/route.ts`) already routes SA-no-ref → `/api/system-admin/dashboard/sale/stats` aggregate, so no proxy change needed.

**Verification needed first**: confirm `GET /api/system-admin/dashboard/sale/stats` (no ref) returns real aggregate totals for a multi-location SA. If yes, ship the gate removal. If it returns $0/400, the gate stays and this is an FM backend question.

---

## Track 3 — Default menu selection (VERIFIED — finding)

**FM uses raw `menus[0]`** in API order with NO client sort (`checkout-pantry.component.ts:579`). The menu has a backend `position` field (admin `updatePosition` at `menu.service.ts:66-68`), but the public `/public-api/menu` response shape does NOT expose `position` in the Angular `IMealPackageResponse` interface (`meal-packages/meal-package.model.ts:5-25` has `menu?: number` but no `position`).

So the prior E.2 fix (commit `476ecd0`, sort by `position` ascending) sorts by a field that **may not be present on the public response**:
- If `position` IS returned → primary menu (position 0) leads. Correct.
- If `position` is NOT returned → all entries fall to `MAX_SAFE_INTEGER`, stable sort preserves API order = exactly what FM does (`menus[0]`).

**Conclusion**: the E.2 fix is safe either way — it's a no-op that degrades to FM's exact behavior when `position` is absent, and improves on it (admin-defined primary first) when present. It does NOT introduce alphabetical sorting. **E.2 is correct as shipped.** The "[Copy] Summer Menu shows first" symptom, if it persists, means FM's `/public-api/menu` returns that menu first in raw order — which FM's own checkout would also show. That's an FM data/ordering question, not a Disco Cater bug. `[NEEDS REVIEW]` — confirm against the live `/public-api/menu?restaurantReference=testkitchen` response.

---

## Track 4 — Category section header sticky (VERIFIED — no change needed)

The user's premise was that FM's category section headers stick on scroll. **FM source shows otherwise:**
- FM makes the `.categories-line` (the category TAB/NAV bar at the top) sticky: `position: sticky; top: 0; z-index: 9` (`checkout-pantry.component.scss:168-172`).
- The individual category SECTION headers (`<h2 class="title">{{category.name}}</h2>`, `checkout-pantry.component.html:121`) are **NOT sticky** — they scroll away normally with the content.

So Disco Cater's current behavior (category section headers in normal flow, after the prior un-stick fix `e249d52`) **already matches FM exactly.** No change needed.

If Disco Cater later wants a sticky category NAV bar (the `.categories-line` equivalent — a horizontal scroll-spy of category names that sticks at top), that's a NEW feature, not a restoration. Out of scope. Documented for a future enhancement session.

---

## Session summary (this doc's tracks)

| Track | Outcome |
|---|---|
| 1 — Orders aggregation | ✅ Built (additive, low-risk). Needs live verify of `/api/system-admin/orders` shape. |
| 2 — Reporting aggregation | 📋 Documented + exact change spec'd. NOT shipped — regression risk on a fragile page; needs live verify of the aggregate sale-stats endpoint first. |
| 3 — Default menu (E.2) | ✅ Verified correct as shipped (`476ecd0`). Safe no-op when `position` absent. |
| 4 — Sticky header | ✅ Verified — current normal-flow headers already match FM. No change. |

### Open questions for Peter
1. **Track 1 live verify** — log in as a multi-location SA, open Orders with no location picked. Expect aggregated orders across all locations + a Restaurant column. Confirm `restaurantName` populates per row.
2. **Track 2 go/no-go** — does `GET /api/system-admin/dashboard/sale/stats` (no ref) return real aggregate totals? If yes, I'll ship the gate removal next session. If $0/400, it's an FM backend question.
3. **Track 3** — confirm the testkitchen `/public-api/menu` raw order; if the copy menu is genuinely first there, it's an FM data issue (reorder via admin `updatePosition`).
