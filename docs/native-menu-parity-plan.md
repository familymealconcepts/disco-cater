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

## Build order & progress

- **Stage 0 — Native checkout audit** 🟨 (in progress; report before continuing)
- **Stage 1 — Modifier library (Neon)** ⬜
- **Stage 2 — Group library (Neon)** ⬜
- **Stage 3 — Attach groups to items** ⬜
- **Stage 4 — Customer consumption of modifiers/groups (render + native pricing)** ⬜
- **Stage 5 — Menu money/timing settings** ⬜
- **Stage 6 — Menu delivery settings** ⬜
- **Stage 7 — Skipped days (menu) + Closed Days (restaurant)** ⬜
- **Stage 8 — Item fields (display price, min qty, dietary, special instructions)** ⬜
- **Stage 9 — Restaurant-level settings (delivery time-window granularity, online-ordering, tax, notifications)** ⬜
- **Stage 10 — Location-level (fulfillment options offered)** ⬜
- **Stage 11 — Small extras (utensils toggle, category visibility)** ⬜
- **Stage 12 — Bulk Menu Editor (SYSTEM_ADMIN, cross-location)** ⬜
- **Stage 13 — Multi-Unit Links** ⬜
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
