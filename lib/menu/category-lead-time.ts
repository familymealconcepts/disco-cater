// A lead time that applies to ONE CATEGORY rather than to a whole menu.
//
// ── WHAT THIS IS, AND WHY IT IS NARROW ──────────────────────────────────────
// Colonial Ranch Market sells Freezer Meat Packages ($99.99–$899.99, ten items)
// that the butcher needs two days to put together. Everything else on the same
// menu — pork, poultry, steaks, ground meats, marinades — is cut to order and
// goes out in two hours.
//
// Disco has no per-category lead time. `lead_time_hours` lives on `disco_menus`
// and nowhere else; `disco_menu_categories` carries no scheduling columns at
// all. The Butcher Menu's lead time is 2 hours, and raising it to 48 would have
// delayed 79 items that need no notice whatsoever — the entire butcher counter.
//
// Peter asked for the narrow version: this one category, this one restaurant,
// hardcoded. The general design is written out below so the next person finds
// the answer instead of re-deriving it.
//
// ── THE GENERAL SOLUTION, IF THIS COMES UP AGAIN ────────────────────────────
// Add ONE nullable column and delete this table:
//
//     ALTER TABLE disco_menu_categories ADD COLUMN lead_time_hours INTEGER;
//
//   * NULL INHERITS THE MENU. That is the default for every existing row, so
//     the migration changes no restaurant's behaviour on the day it ships.
//   * EFFECTIVE LEAD = max(menu.lead_time_hours, category.lead_time_hours).
//     Taking the max is the whole safety property: a category can only ever
//     make a rule STRICTER, never shorter. Without it, a category value of 0
//     would silently undercut a menu-level lead time the restaurant had
//     deliberately set, and the category editor would become a way to defeat
//     the menu editor.
//   * The portal needs one number input in the category editor, beside name /
//     description / visible. Offer to pre-fill the description sentence when a
//     lead time is set — editable, never generated at render time, or the
//     restaurant cannot change its own wording and two sources of truth fight.
//
// The three enforcement points below do not change under the general version.
// Swapping the lookup in `categoryLeadTimeHours` for a column read is the
// entire migration; everything downstream already speaks in hours.
//
// ── WHERE THIS IS ENFORCED (all three, deliberately) ────────────────────────
//   1. ADD TO CART   — RestaurantClient.tsx: the card states the requirement,
//                      and refuses the add when the chosen date is inside it.
//   2. DATE CHANGE   — RestaurantClient.tsx: `cartLeadBreaches` is DERIVED from
//                      (cart × selDate × selTime), so it re-evaluates on every
//                      path that changes the date rather than on the two that
//                      exist today. Affected items are named, never dropped.
//   3. CHECKOUT      — isNativeDateTimeValid() in lib/order/native-checkout.ts.
//                      The only one of the three a direct API call cannot skip,
//                      and therefore the only one that is actually load-bearing.
//                      The other two exist so the customer is told early.
//
// ── STAFF DIRECT ENTRY IS EXEMPT, EXPLICITLY ────────────────────────────────
// Peter's ruling: the rule protects the kitchen's prep time, and staff taking a
// phone order ARE the kitchen. If the butcher says he can have it ready
// Wednesday, the portal has no business arguing.
//
// The exemption is a named parameter passed from the direct-entry route
// (`exemptCategoryLeadTimes`), NOT an accident of which code path runs. Both
// money paths share `buildNativePlaceInput`, so an exemption that worked by
// omission would have silently extended itself to the customer path the first
// time someone refactored. Order editing stays exempt as it already is — it
// never calls placeNativeCheckout at all, which is the same reason item
// minimums do not apply there.
import { earliestPickup, wallClockInZone } from '../scheduling/cutoffs'

/**
 * Category reference → required notice, in hours.
 *
 * THE KEY IS THE CATEGORY'S `reference` (disco_menu_categories.reference), not
 * its name. A name is edited in the portal by a restaurant that has no idea
 * this table exists; the reference is stable for the life of the row.
 *
 * Colonial Ranch Market (ecf9bfdc-eb23-4ce4-b8c6-91ab14061cd5)
 *   "Freezer Meat Packages" on Butcher Menu (Pickup & Delivery), whose own
 *   lead time is 2h. The effective rule is max(2, 48) = 48.
 */
export const CATEGORY_LEAD_TIME_HOURS: Readonly<Record<string, number>> = Object.freeze({
  '2df615a7-fcc2-4d95-8b2a-7619d0c0bdcc': 48,
})

/** The required notice for a category, or null when it has none (every other category). */
export function categoryLeadTimeHours(categoryReference: string | null | undefined): number | null {
  if (!categoryReference) return null
  const h = CATEGORY_LEAD_TIME_HOURS[categoryReference]
  return typeof h === 'number' && h > 0 ? h : null
}

/** True when ANY category anywhere carries a rule — lets callers skip the work entirely. */
export function anyCategoryLeadTimes(): boolean {
  return Object.keys(CATEGORY_LEAD_TIME_HOURS).length > 0
}

/** The quiet line on the item card, shown whether or not the chosen date breaches it. */
export function categoryLeadNotice(hours: number): string {
  return `Needs ${hours} hours' notice`
}

/**
 * Whether a chosen slot clears a category's lead time.
 *
 * PURE, and shared verbatim by the card, the date-change check and the server
 * gate. Three surfaces answering this question three ways is how a customer
 * gets offered a slot the server then refuses, with no explanation — the exact
 * failure wallClockInZone was added to fix for menu-level lead times.
 *
 * The restaurant's clock, not the caller's. `now` is a real instant; everything
 * it is compared against is a wall-clock value the restaurant typed. This runs
 * in the customer's browser zone AND in UTC on Vercel, so the shift has to
 * happen here or the two disagree. See lib/scheduling/cutoffs.ts.
 *
 * No daily/hard cutoff is applied: this is a lead time and nothing else. The
 * menu's own cutoffs are the menu gate's job, and both gates run — which is
 * what makes the effective rule max(menu, category) without either knowing
 * about the other.
 *
 * Returns TRUE (satisfied) for unusable input rather than blocking. Callers
 * reject a missing date/time before reaching here — isNativeDateTimeValid's
 * first line does exactly that — and a card with no date selected yet must not
 * render as refused.
 */
export function isCategoryLeadSatisfied(
  leadHours: number,
  dateStr: string,
  timeStr: string,
  now: Date,
  timezone?: string | null,
): boolean {
  if (!leadHours || leadHours <= 0) return true
  if (!dateStr || !timeStr) return true
  const hhmm = timeStr.slice(0, 5)
  const slot = new Date(`${dateStr}T${hhmm.length === 5 ? hhmm : '00:00'}:00`)
  if (Number.isNaN(slot.getTime())) return true
  const earliest = earliestPickup(wallClockInZone(now, timezone), { leadTimeMinutes: leadHours * 60 })
  return slot.getTime() >= earliest.getTime()
}
