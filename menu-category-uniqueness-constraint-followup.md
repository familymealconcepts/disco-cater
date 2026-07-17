# Follow-up: relax menu category uniqueness from restaurant-global to per-menu

**Status:** Open — needs dedicated review (schema migration)
**Opened:** 2026-07-17
**Origin:** Surfaced while building M1 (menu clone) from the FM→Disco-native migration
readiness audit. Deferred deliberately — it's a schema migration that deserves proper
investigation, not a decision under time pressure.

## The constraint
`disco_menu_categories` has a UNIQUE index `uq_disco_menu_categories_rest_name` on
`(restaurant_reference, name)`. Category names are therefore unique across the WHOLE
restaurant, even though each category also carries a `menu_reference` (belongs to one
menu).

## Why it's a problem
- A restaurant **cannot have two menus that both contain a same-named category**
  (e.g. "Appetizers" in both a Lunch menu and a Dinner menu).
- **Menu clone** (shipped, Option A) must disambiguate cloned category names
  ("Platters" → "Platters (Copy)"), which the restaurant then has to rename.

## Proposed change (Option B)
Relax the uniqueness to **`(menu_reference, name)`** — categories unique *per menu*.
Then menus can share category names and clones copy names verbatim.

## Before changing — investigate what depends on restaurant-global category names
- Any query that resolves a category by `(restaurant_reference, name)` without a
  menu scope (the menu import dual-write, admin tools, category find-or-create).
- The bulk-pricing / cross-location item matching (matches items by name — categories?).
- Any customer-facing menu render that assumes category-name uniqueness per restaurant.
- The menu-import `getCategory` find-or-create (currently keyed by menu + name, but
  the INSERT would now be allowed to collide across menus — confirm intended).

## Migration sketch (once cleared)
1. `DROP INDEX uq_disco_menu_categories_rest_name;`
2. `CREATE UNIQUE INDEX uq_disco_menu_categories_menu_name ON disco_menu_categories (menu_reference, name);`
3. Update any find-or-create / lookup that relied on `(restaurant_reference, name)` to
   scope by `menu_reference`.
4. Optionally backfill: strip the "(Copy)" disambiguators that Option A introduced.

## Acceptance
Two menus in one restaurant can each have an "Appetizers" category; menu clone copies
category names verbatim (no "(Copy)" suffix); no regression in import, bulk-pricing, or
customer menu render.

## References
- M1 clone route: `app/api/restaurant/disco-menus/[ref]/clone/route.ts` (Option-A
  disambiguation lives here — remove once this ships).
