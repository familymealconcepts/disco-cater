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
 * ── NULL IS NOT ZERO ────────────────────────────────────────────────────────
 * A null/absent value means FM's payload did not carry a rate, NOT that the rate
 * is zero. Those are returned as null and the caller must leave the existing
 * value alone rather than writing 0 — zeroing a commission on missing data is a
 * revenue decision, and a guess is the wrong way to make one.
 */
export type FmLeadGen = { one: number | null; two: number | null }

export async function fmLeadGenRates(restaurantReference: string): Promise<FmLeadGen> {
  if (!restaurantReference) return { one: null, two: null }
  try {
    const rows = (await sql`
      SELECT (raw->>'leadGenOne') AS one, (raw->>'leadGenTwo') AS two
        FROM disco_restaurant_admin_list_cache
       WHERE restaurant_reference = ${restaurantReference}
       LIMIT 1
    `) as Array<{ one: string | null; two: string | null }>
    if (!rows.length) return { one: null, two: null }
    const num = (v: string | null) => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    return { one: num(rows[0].one), two: num(rows[0].two) }
  } catch {
    // Never fail a conversion over this. A null result leaves the existing rate
    // untouched, which is the same safe outcome as FM holding no value.
    return { one: null, two: null }
  }
}
