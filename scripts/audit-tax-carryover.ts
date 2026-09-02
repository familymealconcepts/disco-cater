/**
 * PRE-CONVERSION tax check: if this FM-backed restaurant converts, will the tax
 * carry-over succeed, and what effective rate will land?
 *
 * ── WHY THIS ONLY LOOKS AT UNCONVERTED RESTAURANTS ─────────────────────────
 * The previous version of this script compared CONVERTED restaurants' Neon
 * tax_rates against FM and printed a DISAGREE column. That comparison is
 * meaningless and actively harmful: after convertToNative runs, Disco owns the
 * data and a difference from FM is a DECISION somebody made, not drift. The
 * column got read as a defect list and led to three converted restaurants
 * (Atlanta Bread Smyrna, Hugo's West Hollywood, Briscola Trattoria) being
 * reported as needing investigation when their rates were deliberate. See
 * CLAUDE.md, "NEVER COMPARE A CONVERTED RESTAURANT AGAINST FM".
 *
 * So this script refuses to compare converted rows at all — it does not print
 * them with a caveat, it excludes them. A script that emits something nobody
 * should read is a trap for whoever runs it next.
 *
 * What remains is the question FM can legitimately answer: for a restaurant that
 * has NOT converted, FM is still the source of truth, and the carry-over is the
 * only thing that will populate Neon at conversion.
 *
 *   npx tsx scripts/audit-tax-carryover.ts [nameFilter]
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { readWalledFieldsForRestaurants } from '../lib/fm-master-admin-read'
import { effectiveTaxPercent, isTaxConfigured } from '../lib/pricing/tax-config'

const FILTER = process.argv[2] || null

const fmt = (t: Parameters<typeof effectiveTaxPercent>[0]) =>
  t ? `${t.stateSalesTax?.percent ?? 'null'}/${t.localSalesTax?.percent ?? 'null'}/${t.otherSalesTax?.percent ?? 'null'}` : 'NO OBJECT'

async function main() {
  // is_disco_native = false, enforced in SQL rather than filtered in the report,
  // so a converted restaurant cannot reach the comparison by any code path here.
  const rows = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, o.tax_rates
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o USING (restaurant_reference)
     WHERE COALESCE(c.is_disco_native, false) = false
       AND c.archived_at IS NULL
       AND (${FILTER}::text IS NULL OR c.name ILIKE '%' || ${FILTER} || '%')
     ORDER BY c.name
  `) as Array<{ ref: string; name: string; tax_rates: never }>

  const converted = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_restaurant_cache WHERE is_disco_native = true AND archived_at IS NULL
  `) as Array<{ n: number }>
  console.log(`FM-backed (unconverted) restaurants in scope: ${rows.length}`)
  console.log(`${converted[0].n} converted restaurants EXCLUDED — Disco owns their tax rates; FM's value is not evidence of anything.\n`)
  if (!rows.length) { process.exit(0) }

  const walled = await readWalledFieldsForRestaurants(rows.map(r => r.ref))

  const willCarry: string[] = [], wontCarry: string[] = [], unreadable: string[] = []
  for (const r of rows) {
    const w = walled.get(r.ref)
    const neonHas = isTaxConfigured(r.tax_rates as never)
    if (!w?.ok || !w.taxRate) {
      unreadable.push(`${r.name.padEnd(38)} neon ${fmt(r.tax_rates as never).padEnd(20)} ${neonHas ? '(Neon already has a rate — conversion is safe)' : 'NEON EMPTY TOO — would convert with no rate'}`)
      continue
    }
    const line = `${r.name.padEnd(38)} FM ${fmt(w.taxRate as never).padEnd(20)} → effective ${String(effectiveTaxPercent(w.taxRate as never) ?? 'null').padEnd(7)} neon now ${fmt(r.tax_rates as never)}`
    if (isTaxConfigured(w.taxRate as never)) willCarry.push(line)
    else wontCarry.push(`${line}   ${neonHas ? '(Neon has a rate, so this is a no-op)' : '*** NEON EMPTY — would convert unable to price any order ***'}`)
  }

  console.log(`── carry-over WILL succeed: ${willCarry.length}`)
  for (const l of willCarry) console.log('   ' + l)
  console.log(`\n── carry-over will REFUSE (FM has no numeric percent anywhere): ${wontCarry.length}`)
  for (const l of wontCarry) console.log('   ' + l)
  console.log(`\n── FM unreadable (no real per-restaurant admin identity): ${unreadable.length}`)
  for (const l of unreadable) console.log('   ' + l)

  const blocked = unreadable.filter(l => l.includes('NEON EMPTY TOO')).length + wontCarry.filter(l => l.includes('***')).length
  console.log(`\n── restaurants that would convert with NO usable tax rate: ${blocked}`)
  console.log('   (each would pass nothing to price with — checkout refuses, every order 409s)')
}
main().catch(e => { console.error(e); process.exit(1) })
