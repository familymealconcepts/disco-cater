import { sql } from './db'

/**
 * FamilyMeal's lead-gen commission rates for a restaurant.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Conversion copies FamilyMeal's data; it does not set defaults. Lead-gen was the
 * exception: disco_restaurant_overrides.lead_gen_one_pct / _two_pct carry column
 * DEFAULTs of 15 and 5, so every converted restaurant silently inherited Disco's
 * new-restaurant rates instead of the ones FamilyMeal actually holds for it.
 *
 * Measured across the 188 converted restaurants with an FM record: 186 differed.
 * FM held 0/0 for 132 of them, 15/3 for 32, 5/5 for 17. Disco held 15/5 for 187.
 * Every difference was Disco charging MORE than FamilyMeal; none charged less.
 *
 * ── THE SOURCE ──────────────────────────────────────────────────────────────
 * FM stores these on the Restaurant entity as lead_gen_one / lead_gen_two
 * (Integer, entity default 0) and exposes them as leadGenOne / leadGenTwo on the
 * admin restaurant payload. disco_restaurant_admin_list_cache.raw already holds
 * that payload for every FM restaurant, refreshed every 15 minutes, so this needs
 * no call to FamilyMeal — which also means it cannot fail a conversion when FM is
 * slow or unreachable.
 *
 * ── WHAT NULL MEANS IN FAMILYMEAL: ZERO ─────────────────────────────────────
 * FM's admin DTO is @JsonInclude(NON_NULL), so a MISSING leadGenOne/leadGenTwo
 * key means the column is null in FM's database, not that the payload dropped a
 * value. And FM's own charge-time code resolves a null rate to zero —
 * RestaurantSaleTransactionServiceImpl.applyDiscoLeadGenFees:
 *
 *     private static final int DEFAULT_LEAD_GEN_ONE_PERCENT = 0;
 *     private static final int DEFAULT_LEAD_GEN_TWO_PERCENT = 0;
 *     ...
 *     int percentWhole = isFirstOrder
 *             ? Objects.requireNonNullElse(order.getRestaurant().getLeadGenOne(), DEFAULT_LEAD_GEN_ONE_PERCENT)
 *             : Objects.requireNonNullElse(order.getRestaurant().getLeadGenTwo(), DEFAULT_LEAD_GEN_TWO_PERCENT);
 *
 * So a null rate at FamilyMeal charges nothing. `nullMeansZero` below resolves a
 * present-but-null FM record to 0, which IS carrying FM's value rather than
 * inventing one. It is returned as null ONLY when FM has no record of the
 * restaurant at all — there is nothing to carry then, and the caller leaves
 * Disco's own new-restaurant defaults in place.
 *
 * ── THE REFERENCE TO LOOK UP ────────────────────────────────────────────────
 * A converted restaurant's Disco reference is not always its FamilyMeal one: 19
 * of 209 native restaurants carry a different fm_restaurant_reference. Looking
 * up by the Disco reference alone silently found nothing for 5 of them and left
 * Disco's defaults standing. Both are tried, Disco's reference first.
 */
export type FmLeadGen = {
  one: number | null
  two: number | null
  /** true when FamilyMeal has a record of this restaurant at all. */
  fmHasRecord: boolean
}

export async function fmLeadGenRates(restaurantReference: string): Promise<FmLeadGen> {
  const none: FmLeadGen = { one: null, two: null, fmHasRecord: false }
  if (!restaurantReference) return none
  try {
    const rows = (await sql`
      SELECT (a.raw->>'leadGenOne') AS one, (a.raw->>'leadGenTwo') AS two
        FROM disco_restaurant_admin_list_cache a
       WHERE a.restaurant_reference = ${restaurantReference}
          -- A converted restaurant's FamilyMeal reference is not always its Disco
          -- one. Fall back to the reference the account records for FM.
          OR a.restaurant_reference = (
               SELECT x.fm_restaurant_reference FROM disco_restaurant_accounts x
                WHERE x.restaurant_reference = ${restaurantReference}
                  AND x.fm_restaurant_reference IS NOT NULL
                LIMIT 1
             )
       ORDER BY (a.restaurant_reference = ${restaurantReference}) DESC
       LIMIT 1
    `) as Array<{ one: string | null; two: string | null }>
    if (!rows.length) return none

    // FM has a record. A missing key means the column is null there, and FM
    // charges zero on a null rate (see the header) — so zero is FM's value.
    const num = (v: string | null) => {
      if (v === null || v === undefined || v === '') return 0
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    }
    return { one: num(rows[0].one), two: num(rows[0].two), fmHasRecord: true }
  } catch {
    // Never fail a conversion over this. Treated as "no FM record", which leaves
    // the existing rate untouched.
    return none
  }
}
