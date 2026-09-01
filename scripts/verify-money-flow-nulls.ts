/**
 * Runs reconcileMoneyFlow() and reports what the relaxed NULL clause moved.
 *
 * Splits the output the way the decision splits: FM-backed fills are mirror
 * corrections (FM is authoritative pre-conversion), value corrections are the
 * reconciler's original job, and disco-native NULLs are reported but never
 * written because Disco owns those.
 *
 *   npx tsx scripts/verify-money-flow-nulls.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { reconcileMoneyFlow } from '../lib/money-flow-reconcile'

async function main() {
  const before = (await sql`
    SELECT COALESCE(c.is_disco_native,false) AS native, o.money_flow::text AS v, count(*)::int AS n
      FROM disco_restaurant_overrides o
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
     GROUP BY 1,2 ORDER BY 1,2
  `) as { native: boolean; v: string | null; n: number }[]
  console.log('BEFORE:')
  for (const r of before) console.log(`   native=${r.native}  ${String(r.v ?? 'NULL').padEnd(12)} ${r.n}`)

  const r = await reconcileMoneyFlow()

  console.log(`\nrows checked: ${r.total}   agreeing: ${r.matched}   written: ${r.flipped}   of which FILLS: ${r.filled}   FM errors: ${r.errored}   ${Math.round(r.durationMs / 1000)}s`)

  const fills = r.flips.filter(f => f.filled)
  const corrections = r.flips.filter(f => !f.filled)

  console.log(`\n── FILLS (Neon had NO value; FM's value written) — ${fills.length}`)
  for (const f of fills) console.log(`   ${(f.name || f.restaurantReference).padEnd(40)} NULL → ${f.after}`)

  console.log(`\n── CORRECTIONS (Neon had a stale value) — ${corrections.length}`)
  for (const f of corrections) console.log(`   ${(f.name || f.restaurantReference).padEnd(40)} ${f.before} → ${f.after}${f.dangerous ? '   ⚠ DANGEROUS DIRECTION' : ''}`)

  console.log(`\n── DISCO-NATIVE, LEFT NULL ON PURPOSE (Disco owns these) — ${r.nativeNulls.length}`)
  for (const n of r.nativeNulls) console.log(`   ${(n.name || n.restaurantReference).padEnd(40)} FM says: ${n.fmValue ?? 'no FM record'}`)

  const after = (await sql`
    SELECT COALESCE(c.is_disco_native,false) AS native, o.money_flow::text AS v, count(*)::int AS n
      FROM disco_restaurant_overrides o
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
     GROUP BY 1,2 ORDER BY 1,2
  `) as { native: boolean; v: string | null; n: number }[]
  console.log('\nAFTER:')
  for (const x of after) console.log(`   native=${x.native}  ${String(x.v ?? 'NULL').padEnd(12)} ${x.n}`)

  // The invariant: no disco-native row may be filled by this job.
  const nativeFilled = (await sql`
    SELECT count(*)::int AS n FROM disco_restaurant_overrides o
      JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
     WHERE c.is_disco_native = true AND o.money_flow IS NULL
  `) as { n: number }[]
  console.log(`\nINVARIANT disco-native rows still NULL: ${nativeFilled[0]?.n} (expected ${r.nativeNulls.length})  ${nativeFilled[0]?.n === r.nativeNulls.length ? 'PASS' : 'FAIL'}`)
  process.exit(nativeFilled[0]?.n === r.nativeNulls.length ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
