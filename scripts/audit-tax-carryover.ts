/**
 * Does Neon's tax_rates match FM field-for-field for every converted restaurant,
 * or only on state?
 *
 * carryOverTaxRates WRITES the whole FM object, but GUARDS on
 * stateSalesTax.percent alone — so a restaurant whose real rate lives in local
 * (with no state rate) is refused entirely, and nothing is carried.
 *
 *   npx tsx scripts/audit-tax-carryover.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { readWalledFieldsForRestaurants } from '../lib/fm-master-admin-read'
import { effectiveTaxPercent } from '../lib/pricing/tax-config'

const p = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const fmt = (t: { stateSalesTax?: { percent?: number | null } | null; localSalesTax?: { percent?: number | null } | null; otherSalesTax?: { percent?: number | null } | null } | null) =>
  t ? `${t.stateSalesTax?.percent ?? 'null'}/${t.localSalesTax?.percent ?? 'null'}/${t.otherSalesTax?.percent ?? 'null'}` : 'NO OBJECT'

async function main() {
  const rows = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, o.tax_rates
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o USING (restaurant_reference)
     WHERE c.is_disco_native = true AND c.archived_at IS NULL
     ORDER BY c.name
  `) as Array<{ ref: string; name: string; tax_rates: never }>
  console.log(`converted restaurants: ${rows.length}\n`)

  const walled = await readWalledFieldsForRestaurants(rows.map(r => r.ref))

  const agree: string[] = [], disagree: string[] = [], unreadable: string[] = []
  for (const r of rows) {
    const w = walled.get(r.ref)
    const neon = r.tax_rates as never
    if (!w?.ok || !w.taxRate) { unreadable.push(`${r.name} — neon ${fmt(neon)}, FM unreadable (${String(w?.reason ?? '').slice(0, 44)})`); continue }
    const fm = w.taxRate as never
    const same = (a: unknown, b: unknown) => (p(a) ?? null) === (p(b) ?? null)
    const ok = same((neon as never as Record<string, never>)?.['stateSalesTax'] && (neon as never as { stateSalesTax?: { percent?: number } }).stateSalesTax?.percent, (fm as { stateSalesTax?: { percent?: number } }).stateSalesTax?.percent)
      && same((neon as { localSalesTax?: { percent?: number } })?.localSalesTax?.percent, (fm as { localSalesTax?: { percent?: number } }).localSalesTax?.percent)
      && same((neon as { otherSalesTax?: { percent?: number } })?.otherSalesTax?.percent, (fm as { otherSalesTax?: { percent?: number } }).otherSalesTax?.percent)
    const line = `${r.name.padEnd(36)} neon ${fmt(neon).padEnd(22)} fm ${fmt(fm).padEnd(22)} eff neon=${effectiveTaxPercent(neon) ?? 'null'} fm=${effectiveTaxPercent(fm) ?? 'null'}`
    if (ok) agree.push(line); else disagree.push(line)
  }

  console.log(`── AGREE field-for-field: ${agree.length}`)
  for (const l of agree) console.log('   ' + l)
  console.log(`\n── DISAGREE: ${disagree.length}`)
  for (const l of disagree) console.log('   *** ' + l)
  console.log(`\n── FM UNREADABLE (cannot compare): ${unreadable.length}`)
  for (const l of unreadable) console.log('   ' + l)

  // The dangerous shape Peter named: FM has a rate (so the gate passes) but the
  // carry-over's state-only guard would refuse to write it.
  console.log('\n── WOULD THE CARRY-OVER REFUSE? (FM configured, but stateSalesTax.percent not a number)')
  let refused = 0
  for (const r of rows) {
    const w = walled.get(r.ref)
    if (!w?.ok || !w.taxRate) continue
    const fm = w.taxRate as { stateSalesTax?: { percent?: number | null } }
    const statePct = fm.stateSalesTax?.percent
    const stateOk = typeof statePct === 'number' && Number.isFinite(statePct)
    if (!stateOk && effectiveTaxPercent(w.taxRate as never) != null) {
      refused++
      console.log(`   *** ${r.name} — FM ${fmt(w.taxRate as never)} is configured, but carryOverTaxRates would REFUSE (state is ${statePct ?? 'null'})`)
    }
  }
  if (!refused) console.log('   none among the converted — but see the FM-backed sweep below')
}
main().catch(e => { console.error(e); process.exit(1) })
