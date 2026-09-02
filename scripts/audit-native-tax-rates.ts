/**
 * Fleet audit: which CONVERTED restaurants would charge 0% tax on a native order?
 *
 * checkConversionReadiness's `settings` gate inspects
 * tax_rates.stateSalesTax.percent ONLY, and treats 0 as a real value (correctly —
 * Pelican Delicatessen is deliberately 0%). A restaurant with 0 state and its real
 * rate in localSalesTax therefore passes without ever triggering the live
 * master-password tax read. That is fine when Neon already holds the local rate,
 * and a live money bug when it holds neither.
 *
 * computeBreakdown sums state + local + other, so the effective rate is the sum.
 *
 *   npx tsx scripts/audit-native-tax-rates.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'

const pct = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function main() {
  const rows = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, c.is_live, o.visible,
           o.tax_rates->'stateSalesTax'->>'percent' AS state,
           o.tax_rates->'localSalesTax'->>'percent' AS local,
           o.tax_rates->'otherSalesTax'->>'percent'  AS other,
           (o.tax_rates IS NULL) AS tax_rates_null,
           -- A genuinely NATIVE-placed order, i.e. one Disco itself charged:
           -- disco_sale_transactions.source = 'NATIVE_CHECKOUT'. (disco_orders
           -- .source_of_order is DISCO/FAMILYMEAL lead-gen attribution, not
           -- native-vs-FM, so it is the wrong signal here.)
           (SELECT count(*)::int FROM disco_orders x
              JOIN disco_sale_transactions t ON t.order_id = x.id AND t.source = 'NATIVE_CHECKOUT'
             WHERE x.restaurant_reference = c.restaurant_reference::uuid AND x.is_deleted = false) AS native_orders,
           (SELECT COALESCE(SUM(x.total),0)::numeric(12,2) FROM disco_orders x
              JOIN disco_sale_transactions t ON t.order_id = x.id AND t.source = 'NATIVE_CHECKOUT'
             WHERE x.restaurant_reference = c.restaurant_reference::uuid AND x.is_deleted = false) AS native_revenue,
           -- What tax those native orders actually collected, from the money-of-record row.
           (SELECT COALESCE(SUM(t.state_tax + t.local_tax + t.other_tax),0)::numeric(12,2) FROM disco_orders x
              JOIN disco_sale_transactions t ON t.order_id = x.id AND t.source = 'NATIVE_CHECKOUT'
             WHERE x.restaurant_reference = c.restaurant_reference::uuid AND x.is_deleted = false) AS native_tax_collected
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o USING (restaurant_reference)
     WHERE c.is_disco_native = true AND c.archived_at IS NULL
     ORDER BY c.name
  `) as Array<Record<string, unknown>>

  console.log(`converted (disco-native, un-archived) restaurants: ${rows.length}\n`)

  const zeroState: typeof rows = []
  const zeroEverything: typeof rows = []
  for (const r of rows) {
    const s = pct(r.state), l = pct(r.local), ot = pct(r.other)
    const effective = (s ?? 0) + (l ?? 0) + (ot ?? 0)
    if (s === 0 || s === null) zeroState.push(r)
    if (effective === 0) zeroEverything.push(r)
  }

  console.log(`── stateSalesTax is 0 or missing: ${zeroState.length}`)
  for (const r of zeroState) {
    const s = pct(r.state), l = pct(r.local), ot = pct(r.other)
    const eff = (s ?? 0) + (l ?? 0) + (ot ?? 0)
    console.log(`   ${String(r.name).padEnd(34)} state=${String(r.state ?? 'null').padEnd(6)} local=${String(r.local ?? 'null').padEnd(6)} other=${String(r.other ?? 'null').padEnd(5)} → EFFECTIVE ${eff}%   native_orders=${r.native_orders} ($${r.native_revenue})`)
  }

  console.log(`\n── EFFECTIVE RATE 0% (state + local + other all 0/absent): ${zeroEverything.length}`)
  if (!zeroEverything.length) console.log('   none')
  for (const r of zeroEverything) {
    const live = Number(r.native_orders) > 0
    console.log(`   ${live ? '*** LIVE MONEY ***' : 'no native orders yet'}  ${String(r.name).padEnd(34)} tax_rates_null=${r.tax_rates_null}  native_orders=${r.native_orders} ($${r.native_revenue})  tax_collected=$${r.native_tax_collected}  is_live=${r.is_live} visible=${r.visible}`)
  }

  const bleeding = zeroEverything.filter(r => Number(r.native_orders) > 0)
  console.log(`\n── VERDICT`)
  console.log(`   converted restaurants charging an effective 0% tax : ${zeroEverything.length}`)
  console.log(`   ...of which have actually taken native orders      : ${bleeding.length}`)
  if (bleeding.length) {
    const total = bleeding.reduce((a, r) => a + Number(r.native_revenue), 0)
    const tax = bleeding.reduce((a, r) => a + Number(r.native_tax_collected), 0)
    console.log(`   native revenue booked at an effective 0% rate      : $${total.toFixed(2)}`)
    console.log(`   tax actually collected on it                       : $${tax.toFixed(2)}`)
  }
  // For contrast: the ones a state-only gate would have caught anyway.
  const realState = rows.filter(r => (pct(r.state) ?? 0) > 0).length
  console.log(`   converted restaurants with a real state rate       : ${realState}`)
}
main().catch(e => { console.error(e); process.exit(1) })
