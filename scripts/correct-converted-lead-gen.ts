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
 * NULL IS NOT ZERO: where FM's payload carries no rate, the restaurant is left
 * exactly as it is and reported. Writing 0 there would eliminate commission on
 * missing data — a revenue decision made by guess.
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
           (a.raw->>'leadGenOne') AS fm_one,
           (a.raw->>'leadGenTwo') AS fm_two
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      LEFT JOIN disco_restaurant_admin_list_cache a ON a.restaurant_reference = c.restaurant_reference
     WHERE c.is_disco_native = true
     ORDER BY c.name
  `) as Array<{ ref: string; name: string; disco_one: number | null; disco_two: number | null; fm_one: string | null; fm_two: string | null }>

  const num = (v: string | null) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v); return Number.isFinite(n) ? n : null
  }

  const toFix: Array<{ ref: string; name: string; from: string; to: string; one: number | null; two: number | null }> = []
  const noFmValue: string[] = []
  const noFmRecord: string[] = []
  let alreadyRight = 0

  for (const r of rows) {
    const one = num(r.fm_one), two = num(r.fm_two)
    if (r.fm_one === null && r.fm_two === null) {
      // No FM row at all in the cache, or the payload had neither key.
      const hasCacheRow = r.fm_one !== undefined
      ;(hasCacheRow ? noFmValue : noFmRecord).push(`${r.name} (${r.ref}) — Disco holds ${r.disco_one}/${r.disco_two}, left unchanged`)
      continue
    }
    if (one === null && two === null) { noFmValue.push(`${r.name} (${r.ref}) — Disco holds ${r.disco_one}/${r.disco_two}, left unchanged`); continue }
    const newOne = one ?? r.disco_one, newTwo = two ?? r.disco_two
    if (newOne === r.disco_one && newTwo === r.disco_two) { alreadyRight++; continue }
    toFix.push({ ref: r.ref, name: r.name, from: `${r.disco_one}/${r.disco_two}`, to: `${newOne}/${newTwo}`, one, two })
  }

  console.log(`native restaurants with an overrides row: ${rows.length}`)
  console.log(`already matching FM:                      ${alreadyRight}`)
  console.log(`to correct:                               ${toFix.length}`)
  console.log(`FM holds no lead-gen value (left as-is):  ${noFmValue.length}`)
  console.log(`no FM admin-cache row at all (as-is):     ${noFmRecord.length}`)

  const byChange = new Map<string, number>()
  for (const f of toFix) byChange.set(`${f.from} -> ${f.to}`, (byChange.get(`${f.from} -> ${f.to}`) || 0) + 1)
  console.log('\nchanges by shape:')
  for (const [k, v] of [...byChange.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

  if (noFmValue.length) { console.log('\nFM holds no value — LEFT UNCHANGED (null is not zero):'); noFmValue.forEach(l => console.log('  ' + l)) }
  if (noFmRecord.length) { console.log('\nno FM admin-cache row — LEFT UNCHANGED:'); noFmRecord.forEach(l => console.log('  ' + l)) }

  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return }

  let written = 0
  for (const f of toFix) {
    await sql`
      UPDATE disco_restaurant_overrides
         SET lead_gen_one_pct = COALESCE(${f.one}, lead_gen_one_pct),
             lead_gen_two_pct = COALESCE(${f.two}, lead_gen_two_pct),
             updated_at = NOW()
       WHERE restaurant_reference = ${f.ref}
    `
    written++
  }
  console.log(`\nWROTE ${written} restaurant(s).`)

  const after = (await sql`
    SELECT COUNT(*)::int AS n
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      JOIN disco_restaurant_admin_list_cache a ON a.restaurant_reference = c.restaurant_reference
     WHERE c.is_disco_native = true
       AND a.raw->>'leadGenOne' IS NOT NULL
       AND (o.lead_gen_one_pct::float8 <> (a.raw->>'leadGenOne')::float8
         OR o.lead_gen_two_pct::float8 <> (a.raw->>'leadGenTwo')::float8)
  `) as Array<{ n: number }>
  console.log(`VERIFY: restaurants still differing from FM where FM holds a value: ${after[0].n}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
