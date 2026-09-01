/**
 * Sets the shared commissary pickup address for both Gracious Bakery & Cafe
 * locations. Courier-only — see lib/commissary.ts.
 *
 *   npx tsx scripts/set-gracious-commissary.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql, runMigrations } from '../lib/db'
import { setCommissaryAddress, readCommissaryPickup } from '../lib/commissary'

const REFS = [
  ['Gracious Bakery & Cafe - Garden District', 'a2149c92-f97c-420a-8acf-34a7a59909b8'],
  ['Gracious Bakery & Cafe - Uptown', '28aedfe8-fcd7-4d9c-b765-6d3deb47be4f'],
] as const

const COMMISSARY = {
  name: 'Gracious Bakery - Commissary',
  addressLine1: '7220 Earhart Blvd',
  city: 'New Orleans',
  state: 'LA',
  zipcode: '70125',
}

async function main() {
  await runMigrations()
  for (const [label, ref] of REFS) {
    const res = await setCommissaryAddress(ref, COMMISSARY)
    console.log(`\n${label}`)
    if (!res.ok) { console.log(`   REFUSED: ${res.reason}`); continue }
    console.log(`   geocoded "${res.geocodedFrom}" → ${res.lat}, ${res.lng}`)
    const back = await readCommissaryPickup(ref)
    console.log(`   read back: ${back ? `${back.name} | ${back.street1}, ${back.city} ${back.state} ${back.zip} | ${back.lat},${back.lng}` : 'NULL (not dispatchable)'}`)
  }

  // The safety property, asserted rather than assumed: the commissary must not
  // have reached either shared address source.
  const leak = (await sql`
    SELECT c.name, c.address AS cache_address,
           (SELECT count(*)::int FROM disco_orders o
             WHERE o.restaurant_reference::text = c.restaurant_reference
               AND o.restaurant_address ILIKE '%Earhart%') AS orders_with_commissary
      FROM disco_restaurant_cache c
     WHERE c.restaurant_reference = ANY(${REFS.map(r => r[1])}::text[]) ORDER BY 1`) as Array<Record<string, unknown>>
  console.log('\nSAFETY — the commissary must appear in NEITHER shared source:')
  let bad = 0
  for (const r of leak) {
    const inCache = String(r.cache_address ?? '').toLowerCase().includes('earhart')
    const inOrders = Number(r.orders_with_commissary) > 0
    if (inCache || inOrders) bad++
    console.log(`   ${String(r.name).padEnd(42)} cache_address has Earhart: ${inCache ? 'YES — LEAK' : 'no'}   orders carrying it: ${r.orders_with_commissary}`)
  }
  console.log(`\n   ${bad === 0 ? 'PASS — no leak into disco_restaurant_cache or disco_orders' : 'FAIL — commissary leaked into a customer-facing source'}`)
  process.exit(bad === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
