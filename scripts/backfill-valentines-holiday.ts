/**
 * Repairs Valentine's Day closures that carried over from FM as ORPHANS.
 *
 * FM emits "Valentines Day" (no apostrophe); Disco's canonical name is
 * "Valentine's Day". The alias map missed it, so `holiday` was left NULL and the
 * closure was stored as a one-off custom closure instead of a holiday. Effects:
 * the Closed Holidays checkbox reads UNTICKED while the restaurant is closed,
 * and only the years FM carried are blocked — all six DeCheco's locations had
 * 2024-2027 and would have been silently OPEN on Valentine's Day 2028 onward.
 *
 * REPLACES, NEVER SUPPLEMENTS. The orphan rows are deleted in the same
 * transaction that inserts the 50-year set, because:
 *   - the table has NO unique constraint on (restaurant, date), so nothing stops
 *     duplicates; and
 *   - the settings toggle deletes by `holiday = $name`, which would not match a
 *     row whose holiday is NULL. Toggling the box in the UI would therefore leave
 *     the orphans behind and double-book 2026 and 2027.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *
 *   npx tsx scripts/backfill-valentines-holiday.ts
 *   npx tsx scripts/backfill-valentines-holiday.ts --apply
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { holidayDates, canonicalHolidayName } from '../lib/holidays'

const APPLY = process.argv.includes('--apply')
const FM_NAME = 'Valentines Day'
const CANON = canonicalHolidayName(FM_NAME)   // "Valentine's Day"

async function main() {
  if (CANON === FM_NAME) {
    console.error(`The alias is missing: canonicalHolidayName("${FM_NAME}") still returns "${CANON}". Fix lib/holidays.ts first.`)
    process.exit(1)
  }
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — "${FM_NAME}" → "${CANON}"\n`)

  const orphans = (await sql`
    SELECT cd.restaurant_reference::text AS ref, c.name AS restaurant,
           cd.from_date::text AS d
    FROM disco_restaurant_closed_days cd
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = cd.restaurant_reference::text
    WHERE cd.name = ${FM_NAME} AND cd.holiday IS NULL
    ORDER BY c.name, cd.from_date
  `) as unknown as { ref: string; restaurant: string | null; d: string }[]

  if (!orphans.length) { console.log('No orphan rows. Nothing to do.'); return }

  const byRef = new Map<string, { restaurant: string; dates: string[] }>()
  for (const o of orphans) {
    if (!byRef.has(o.ref)) byRef.set(o.ref, { restaurant: o.restaurant || o.ref, dates: [] })
    byRef.get(o.ref)!.dates.push(o.d)
  }

  const dates = holidayDates(CANON, new Date().getFullYear())
  console.log(`Replacement set: ${dates.length} dates, ${dates[0]} … ${dates[dates.length - 1]}\n`)

  for (const [ref, info] of byRef) {
    // Guard: a restaurant that ALREADY has the canonical holiday would otherwise
    // end up with two sets. Report and skip rather than merge blindly.
    const existing = (await sql`
      SELECT count(*)::int AS n FROM disco_restaurant_closed_days
      WHERE restaurant_reference = ${ref}::uuid AND holiday = ${CANON}
    `) as unknown as { n: number }[]
    const already = existing[0]?.n ?? 0

    console.log(`${info.restaurant}`)
    console.log(`   orphans: ${info.dates.length} (${info.dates.join(', ')})`)
    console.log(`   existing "${CANON}" rows: ${already}`)
    if (already > 0) { console.log('   SKIPPED — already has the canonical holiday; resolve by hand.\n'); continue }
    console.log(`   → delete ${info.dates.length}, insert ${dates.length}\n`)

    if (APPLY) {
      await sql.transaction([
        sql`DELETE FROM disco_restaurant_closed_days
            WHERE restaurant_reference = ${ref}::uuid AND name = ${FM_NAME} AND holiday IS NULL`,
        sql`INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, holiday, from_date, to_date)
            SELECT ${ref}::uuid, ${CANON}, ${CANON}, d::date, d::date FROM unnest(${dates}::text[]) AS d`,
      ])
    }
  }

  // Post-state, always printed — a dry run shows what is still wrong.
  const after = (await sql`
    SELECT c.name AS restaurant, cd.name, cd.holiday, count(*)::int AS n,
           min(cd.from_date)::text AS first, max(cd.from_date)::text AS last
    FROM disco_restaurant_closed_days cd
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = cd.restaurant_reference::text
    WHERE cd.name ILIKE '%valentine%' OR cd.holiday ILIKE '%valentine%'
    GROUP BY 1,2,3 ORDER BY 1,2
  `) as unknown as Record<string, unknown>[]
  console.log('── Valentine\'s rows now ──')
  after.forEach(r => console.log(`   ${String(r.restaurant).padEnd(40)} name="${r.name}" holiday=${r.holiday ?? 'NULL'} n=${r.n}  ${r.first}..${r.last}`))

  const dupes = (await sql`
    SELECT c.name AS restaurant, cd.from_date::text AS d, count(*)::int AS n
    FROM disco_restaurant_closed_days cd
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = cd.restaurant_reference::text
    WHERE cd.from_date = cd.to_date
    GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 3 DESC LIMIT 10
  `) as unknown as Record<string, unknown>[]
  console.log(`\nDouble-booked (restaurant, date) pairs anywhere in the table: ${dupes.length}`)
  dupes.forEach(r => console.log(`   ${r.restaurant} ${r.d} ×${r.n}`))
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
