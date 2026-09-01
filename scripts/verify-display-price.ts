/**
 * The display-price formatter, checked against EVERY distinct value in the
 * fleet — not a handful of invented cases.
 *
 * A display price is free text a restaurant typed. Some are bare numbers ("2",
 * "43.99") and rendered verbatim they read as broken; the rest carry meaning a
 * formatter must not mangle ("$45.00+" a from-price, "$75.00-$125.00" a range,
 * "$25.00 per person" a unit). This asserts both halves on real data.
 *
 *   npx tsx scripts/verify-display-price.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'

// Same two functions as app/(customer)/restaurants/[slug]/RestaurantClient.tsx.
// Kept in step by the assertion at the end, which reads that file.
const formatPrice = (p: number) => `$${p.toFixed(2)}`
function normalizeDisplayPrice(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ')
  if (!t) return t
  if (t.includes('$')) return t
  const n = Number(t)
  return Number.isFinite(n) ? formatPrice(n) : t
}

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const rows = (await sql`
    SELECT DISTINCT btrim(display_price) AS dp
    FROM disco_menu_items
    WHERE display_price IS NOT NULL AND btrim(display_price) <> ''
    ORDER BY 1
  `) as unknown as { dp: string }[]
  const values = rows.map(r => r.dp)
  console.log(`${values.length} distinct display_price value(s) in the fleet\n`)

  const bare = values.filter(v => !v.includes('$'))
  const withCurrency = values.filter(v => v.includes('$'))

  console.log(`── BARE NUMBERS (${bare.length}) — must gain a currency symbol and 2dp ──`)
  for (const v of bare) {
    const out = normalizeDisplayPrice(v)
    const ok = /^\$\d+\.\d{2}$/.test(out) && Number(out.slice(1)) === Number(v)
    if (!ok) failures++
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  "${v}" → "${out}"`)
  }

  console.log(`\n── ALREADY CARRY A "$" (${withCurrency.length}) — must survive untouched apart from whitespace ──`)
  let mangled = 0
  for (const v of withCurrency) {
    const out = normalizeDisplayPrice(v)
    if (out !== v.replace(/\s+/g, ' ').trim()) { mangled++; console.log(`   FAIL  "${v}" → "${out}"`) }
  }
  check(`none of the ${withCurrency.length} currency-bearing values was altered`, mangled === 0, `${mangled} mangled`)

  console.log('\n── SHAPES THAT MUST NOT BE TOUCHED (spot checks) ──')
  for (const [inp, want] of [
    ['$45.00+', '$45.00+'],
    ['$75.00-$125.00', '$75.00-$125.00'],
    ['$25.00 per person', '$25.00 per person'],
    ['Starting at $45', 'Starting at $45'],
    ['$60.00  ', '$60.00'],
    ['Market price', 'Market price'],
    ['', ''],
  ] as const) check(`"${inp}" → "${want}"`, normalizeDisplayPrice(inp) === want, `got "${normalizeDisplayPrice(inp)}"`)

  console.log('\n── THE FOUR REAL CASES THE COMPARISON FOUND ──')
  for (const [inp, want] of [['5.00', '$5.00'], ['2', '$2.00'], ['60', '$60.00'], ['43.99', '$43.99']] as const)
    check(`"${inp}" → "${want}"`, normalizeDisplayPrice(inp) === want, `got "${normalizeDisplayPrice(inp)}"`)

  // Keep this copy honest against the shipped one.
  const src = (await import('node:fs')).readFileSync('app/(customer)/restaurants/[slug]/RestaurantClient.tsx', 'utf8')
  check('RestaurantClient still routes the display price through normalizeDisplayPrice',
    /return normalizeDisplayPrice\(String\(dp\)\)/.test(src))
  check('...and the shipped body matches this copy',
    /if \(t\.includes\('\$'\)\) return t/.test(src) && /Number\.isFinite\(n\) \? formatPrice\(n\) : t/.test(src))

  console.log('\n' + '='.repeat(60))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
