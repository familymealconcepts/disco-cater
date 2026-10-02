// Each address renders ONCE, across every stored shape.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { formatDisplayAddress, dedupeAddressString } from '../lib/address-display'

let pass = 0, fail = 0
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`}`)
}
/** What every surface now renders. */
const render = (r: any) =>
  formatDisplayAddress({ addressLine1: r.address_line1, addressLine2: r.address_line2, city: r.city, state: r.state, zipcode: r.zipcode })
  || dedupeAddressString(r.address) || r.address || ''

async function main() {
  console.log('1. THE SHAPES')
  // line1 carries a full address with a zip and a country marker
  check('full line1 with zip + USA', formatDisplayAddress({
    addressLine1: '25 11th Ave, New York, NY 10011, USA', city: 'New York', state: 'NY', zipcode: '10011',
  }), '25 11th Ave, New York, NY 10011')
  // no zip anywhere — city/state appended once, not twice
  check('no zip', formatDisplayAddress({
    addressLine1: '3353 Meeting St, North Charleston, SC', city: 'North Charleston', state: 'SC', zipcode: null,
  }), '3353 Meeting St, North Charleston, SC')
  // line1 is street only — the columns fill the gap
  check('street-only line1', formatDisplayAddress({
    addressLine1: '1 Main St', city: 'Dallas', state: 'TX', zipcode: '75201',
  }), '1 Main St, Dallas, TX 75201')
  // a NYC borough in `state` must never print as a state
  check('borough in state is not printed as one', formatDisplayAddress({
    addressLine1: '40-15 82nd St', city: 'Queens', state: 'QUEENS', zipcode: '11375',
  }), '40-15 82nd St, Queens, 11375')
  check('line2 is kept', formatDisplayAddress({
    addressLine1: '6404 Wilshire Blvd', addressLine2: '#100', city: 'Los Angeles', state: 'CA', zipcode: '90048',
  }), '6404 Wilshire Blvd, #100, Los Angeles, CA 90048')
  // the string de-duplicator, for rows whose line1 lacks the street
  check('dedupe keeps the street and drops the repeat',
    dedupeAddressString('200 Clinton St, Brooklyn, NY 11201, USA, Brooklyn, Brooklyn, 11201'),
    '200 Clinton St, Brooklyn, NY 11201')
  check('dedupe leaves an already-clean address alone',
    dedupeAddressString('719 Central Avenue, Westfield, NJ, 07090'),
    '719 Central Avenue, Westfield, NJ, 07090')

  console.log('\n2. ACROSS THE REAL FLEET')
  const rows = (await sql`
    SELECT name, address, address_line1, address_line2, city, state, zipcode FROM disco_restaurant_cache
  `) as any[]
  const withZip = rows.filter(r => (r.zipcode || '').trim())
  const withoutZip = rows.filter(r => !(r.zipcode || '').trim())
  console.log(`  rows: ${rows.length}   with a zip: ${withZip.length}   without: ${withoutZip.length}`)

  // No rendered address may repeat a comma field verbatim.
  const repeats = rows.filter(r => {
    const f = render(r).split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean)
    return new Set(f).size !== f.length
  })
  check('no rendered address repeats a field', repeats.length, 0)
  if (repeats.length) repeats.slice(0, 5).forEach(r => console.log(`     ${r.name}: ${render(r)}`))

  // No rendered address may still carry a country marker.
  const country = rows.filter(r => /\b(usa|u\.s\.a\.?|united states)\b/i.test(render(r)))
  check('no rendered address carries a country marker', country.length, 0)

  // Nothing renders empty that has something stored.
  const lost = rows.filter(r => (r.address || '').trim() && !render(r).trim())
  check('no restaurant renders a blank address', lost.length, 0)

  // Zip-bearing rows keep their zip.
  const zipLost = withZip.filter(r => !render(r).includes(String(r.zipcode).trim()))
  console.log(`  zip-bearing rows whose rendered address omits the zip: ${zipLost.length}`)
  zipLost.slice(0, 3).forEach(r => console.log(`     ${r.name}: "${render(r)}" (zip ${r.zipcode})`))

  console.log('\n3. THE SYNC CANNOT REINTRODUCE IT')
  // restaurant-cache.ts now composes with the same function, so re-composing a
  // row from its own parts is a fixed point.
  const unstable = rows.filter(r => {
    const once = formatDisplayAddress({ addressLine1: r.address_line1, addressLine2: r.address_line2, city: r.city, state: r.state, zipcode: r.zipcode })
    if (!once) return false
    const twice = formatDisplayAddress({ addressLine1: once, addressLine2: null, city: r.city, state: r.state, zipcode: r.zipcode })
    return once !== twice
  })
  check('re-composing is idempotent (a second sync changes nothing)', unstable.length, 0)
  if (unstable.length) unstable.slice(0, 5).forEach(r => console.log(`     ${r.name}`))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
