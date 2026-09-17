/**
 * ONE-TIME: correct converted restaurants to FamilyMeal's lead-gen rates.
 *
 * Conversion never carried FM's lead_gen_one / lead_gen_two, so every converted
 * restaurant inherited disco_restaurant_overrides' column DEFAULTs of 15 / 5 —
 * Disco's rates for a restaurant created NEW on Disco Cater, not FM's rates for
 * this one. The carry is now in lib/native-conversion.ts; this fixes the ones
 * already converted.
 *
 * FM's value is read from disco_restaurant_admin_list_cache.raw (leadGenOne /
 * leadGenTwo), which is FM's own admin payload.
 *
 * NULL AT FAMILYMEAL MEANS ZERO. FM's admin DTO is @JsonInclude(NON_NULL), so a
 * missing leadGenOne/leadGenTwo key means the column is null in FM's database,
 * and FM's charge-time code resolves a null rate to zero:
 *
 *     int percentWhole = isFirstOrder
 *             ? Objects.requireNonNullElse(order.getRestaurant().getLeadGenOne(), DEFAULT_LEAD_GEN_ONE_PERCENT)
 *             : Objects.requireNonNullElse(order.getRestaurant().getLeadGenTwo(), DEFAULT_LEAD_GEN_TWO_PERCENT);
 *     // both DEFAULT_… constants are 0
 *     (RestaurantSaleTransactionServiceImpl.applyDiscoLeadGenFees)
 *
 * So a null rate charges nothing at FamilyMeal, and carrying FM's value means
 * writing 0. Only a restaurant FamilyMeal has NO record of is left alone — there
 * is nothing to carry there, and Disco's new-restaurant defaults stand.
 *
 * The lookup also follows disco_restaurant_accounts.fm_restaurant_reference when
 * it differs from the Disco reference (19 of 209 native restaurants).
 *
 *   npx tsx scripts/correct-converted-lead-gen.ts          # dry run
 *   npx tsx scripts/correct-converted-lead-gen.ts --apply
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'

const APPLY = process.argv.includes('--apply')

async function main() {
  const rows = (await sql`
    SELECT c.restaurant_reference AS ref,
           c.name,
           o.lead_gen_one_pct::float8 AS disco_one,
           o.lead_gen_two_pct::float8 AS disco_two,
           fm.one AS fm_one, fm.two AS fm_two,
           (fm.found IS NOT NULL) AS fm_has_record
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      LEFT JOIN LATERAL (
        SELECT 1 AS found, a.raw->>'leadGenOne' AS one, a.raw->>'leadGenTwo' AS two
          FROM disco_restaurant_admin_list_cache a
         WHERE a.restaurant_reference = c.restaurant_reference
            OR a.restaurant_reference = (
                 SELECT x.fm_restaurant_reference FROM disco_restaurant_accounts x
                  WHERE x.restaurant_reference = c.restaurant_reference
                    AND x.fm_restaurant_reference IS NOT NULL LIMIT 1)
         ORDER BY (a.restaurant_reference = c.restaurant_reference) DESC
         LIMIT 1
      ) fm ON true
     WHERE c.is_disco_native = true
     ORDER BY c.name
  `) as Array<{ ref: string; name: string; disco_one: number | null; disco_two: number | null; fm_one: string | null; fm_two: string | null; fm_has_record: boolean }>

  // A missing key is a null column at FM, and FM charges 0 on a null rate.
  const num = (v: string | null) => {
    if (v === null || v === undefined || v === '') return 0
    const n = Number(v); return Number.isFinite(n) ? n : 0
  }

  const toFix: Array<{ ref: string; name: string; from: string; to: string; one: number; two: number }> = []
  const noFmRecord: string[] = []
  let alreadyRight = 0

  for (const r of rows) {
    if (!r.fm_has_record) {
      noFmRecord.push(`${r.name} (${r.ref}) — no FamilyMeal record; Disco's own ${r.disco_one}/${r.disco_two} stands`)
      continue
    }
    const one = num(r.fm_one), two = num(r.fm_two)
    if (one === r.disco_one && two === r.disco_two) { alreadyRight++; continue }
    toFix.push({ ref: r.ref, name: r.name, from: `${r.disco_one}/${r.disco_two}`, to: `${one}/${two}`, one, two })
  }

  console.log(`native restaurants with an overrides row: ${rows.length}`)
  console.log(`already matching FM:                      ${alreadyRight}`)
  console.log(`to correct:                               ${toFix.length}`)
  console.log(`no FamilyMeal record at all (as-is):      ${noFmRecord.length}`)

  const byChange = new Map<string, number>()
  for (const f of toFix) byChange.set(`${f.from} -> ${f.to}`, (byChange.get(`${f.from} -> ${f.to}`) || 0) + 1)
  console.log('\nchanges by shape:')
  for (const [k, v] of [...byChange.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

  if (noFmRecord.length) { console.log('\nno FamilyMeal record — LEFT UNCHANGED (nothing to carry):'); noFmRecord.forEach(l => console.log('  ' + l)) }

  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return }

  let written = 0
  for (const f of toFix) {
    await sql`
      UPDATE disco_restaurant_overrides
         SET lead_gen_one_pct = ${f.one}, lead_gen_two_pct = ${f.two}, updated_at = NOW()
       WHERE restaurant_reference = ${f.ref}
    `
    written++
  }
  console.log(`\nWROTE ${written} restaurant(s).`)

  const after = (await sql`
    SELECT COUNT(*)::int AS n
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      JOIN LATERAL (
        SELECT COALESCE(NULLIF(a.raw->>'leadGenOne',''),'0')::float8 AS one,
               COALESCE(NULLIF(a.raw->>'leadGenTwo',''),'0')::float8 AS two
          FROM disco_restaurant_admin_list_cache a
         WHERE a.restaurant_reference = c.restaurant_reference
            OR a.restaurant_reference = (
                 SELECT x.fm_restaurant_reference FROM disco_restaurant_accounts x
                  WHERE x.restaurant_reference = c.restaurant_reference
                    AND x.fm_restaurant_reference IS NOT NULL LIMIT 1)
         ORDER BY (a.restaurant_reference = c.restaurant_reference) DESC
         LIMIT 1
      ) fm ON true
     WHERE c.is_disco_native = true
       AND (o.lead_gen_one_pct::float8 <> fm.one OR o.lead_gen_two_pct::float8 <> fm.two)
  `) as Array<{ n: number }>
  console.log(`VERIFY: restaurants with an FM record still differing from FM: ${after[0].n}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
