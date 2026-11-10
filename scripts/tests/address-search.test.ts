// Guards for Google address search on restaurant addresses (Peter, 2026-11-10).
// Run: npx tsx scripts/tests/address-search.test.ts
//
//   1. Picked coordinates are saved by the ONE writer (saveRestaurantAddress) and
//      the geocoder is not asked; manual entry is still geocoded.
//   2. A pick only counts while the address still matches it; bad coordinates never count.
//   3. Address line 2 stays free text: never the search input, never part of the geocode.
//   4. Both forms route through the writer; the pick never reaches FamilyMeal.
import { readFileSync } from 'node:fs'
import { planRestaurantAddressWrite } from '../../lib/restaurant-address'
import { pickedCoords, pickedOneLine, placeToAddressParts } from '../../lib/address-pick'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg) }

const parts = { line1: '36 Beach Rd', line2: 'Suite 2', city: 'Monmouth Beach', state: 'nj', zipcode: '07750' }

async function main() {
  console.log('\n=== the single writer ===')
  await check('picked coordinates are written and the geocoder is never called', async () => {
    const asked: string[] = []
    const plan = await planRestaurantAddressWrite(parts, { lat: 40.33, lng: -73.98 }, async (a) => { asked.push(a); return { lat: 1, lng: 1 } })
    eq(asked, [], 'geocoder calls')
    eq([plan.lat, plan.lng, plan.pin], [40.33, -73.98, 'picked'], 'pin')
    eq(plan.parts.state, 'NJ', 'state upper-cased')
    eq(plan.location, 'Monmouth Beach, NJ', 'location')
  })
  await check('manual entry (no pick) is geocoded, from street/city/state/zip only — never line 2', async () => {
    const asked: string[] = []
    const plan = await planRestaurantAddressWrite(parts, null, async (a) => { asked.push(a); return { lat: 40.1, lng: -74.1 } })
    eq(asked.length, 1, 'geocoder asked once')
    ok(!asked[0].includes('Suite'), `line 2 must not be geocoded: ${asked[0]}`)
    eq([plan.lat, plan.lng, plan.pin], [40.1, -74.1, 'geocoded'], 'pin')
  })
  await check('a geocode miss keeps the old pin (null → COALESCE keeps it)', async () => {
    const plan = await planRestaurantAddressWrite(parts, undefined, async () => null)
    eq([plan.lat, plan.lng, plan.pin], [null, null, 'none'], 'pin')
  })
  await check('half a pick (lat without lng) is not a pick', async () => {
    const plan = await planRestaurantAddressWrite(parts, { lat: 40.33, lng: null }, async () => ({ lat: 5, lng: 6 }))
    eq([plan.lat, plan.lng, plan.pin], [5, 6, 'geocoded'], 'pin')
  })
  const writer = readFileSync('lib/restaurant-address.ts', 'utf8')
  await check('saveRestaurantAddress writes the plan, lat/lng included', () => {
    ok(/saveRestaurantAddress[\s\S]*?planRestaurantAddressWrite\(input, coords\)/.test(writer), 'writer must use planRestaurantAddressWrite(input, coords)')
    ok(/lat = COALESCE\(\$\{lat\}, lat\)/.test(writer) && /lng = COALESCE\(\$\{lng\}, lng\)/.test(writer), 'writer must set lat/lng')
  })

  console.log('\n=== what counts as a pick ===')
  await check('a pick counts only while the saved address is still the picked text', () => {
    const pick = { lat: 40.33, lng: -73.98, address: '36 Beach Rd, Monmouth Beach, NJ 07750' }
    eq(pickedCoords(pick, '36 Beach Rd, Monmouth Beach, NJ 07750'), { lat: 40.33, lng: -73.98 }, 'match')
    eq(pickedCoords(pick, '  36 beach rd,  Monmouth Beach, NJ 07750 '), { lat: 40.33, lng: -73.98 }, 'case/space-insensitive')
    eq(pickedCoords(pick, '38 Beach Rd, Monmouth Beach, NJ 07750'), null, 'hand-edited after the pick')
    eq(pickedCoords(pick, ''), null, 'cleared')
  })
  await check('malformed or out-of-range coordinates never count', () => {
    const a = 'x, y, NJ 07750'
    eq(pickedCoords(null, a), null, 'null')
    eq(pickedCoords({ lat: '40', lng: '-73', address: a }, a), null, 'strings')
    eq(pickedCoords({ lat: 95, lng: -73, address: a }, a), null, 'lat range')
    eq(pickedCoords({ lat: 40, lng: 200, address: a }, a), null, 'lng range')
    eq(pickedCoords({ lat: Number.NaN, lng: 1, address: a }, a), null, 'NaN')
  })
  await check('a Places result → street / city / ST / zip + pin; no street = not a pick', () => {
    const comp = (long_name: string, types: string[], short_name = long_name) => ({ long_name, short_name, types })
    const place = {
      address_components: [comp('36', ['street_number']), comp('Beach Road', ['route'], 'Beach Rd'), comp('Monmouth Beach', ['locality']), comp('New Jersey', ['administrative_area_level_1'], 'NJ'), comp('07750', ['postal_code'])],
      geometry: { location: { lat: () => 40.33, lng: () => -73.98 } },
    }
    const p = placeToAddressParts(place)
    eq(p, { line1: '36 Beach Rd', city: 'Monmouth Beach', state: 'NJ', zipcode: '07750', lat: 40.33, lng: -73.98 }, 'parts')
    eq(pickedOneLine(p!), '36 Beach Rd, Monmouth Beach, NJ 07750', 'one line')
    eq(placeToAddressParts({ address_components: [comp('Monmouth Beach', ['locality'])], geometry: { location: { lat: 1, lng: 1 } } }), null, 'no street')
    eq(placeToAddressParts({ address_components: place.address_components }), null, 'no pin')
  })

  console.log('\n=== the forms and routes ===')
  const profile = readFileSync('app/(restaurant)/restaurant/(portal)/account/profile/page.tsx', 'utf8')
  const dialog = readFileSync('app/(admin)/admin/(protected)/manage-restaurants/EditRestaurantDialog.tsx', 'utf8')
  const profileRoute = readFileSync('app/api/restaurant/disco-profile/route.ts', 'utf8')
  const adminRoute = readFileSync('app/api/admin/restaurants/[ref]/route.ts', 'utf8')
  await check('line 2 stays a free-text input on both forms (never AddressSearchInput)', () => {
    ok(/inp\(discoProfile\.addressLine2,/.test(profile), 'Profile line 2 must stay inp()')
    ok(/<input style=\{input\} value=\{addr2\} onChange=\{e => setAddr2\(e\.target\.value\)\} \/>/.test(dialog), 'Super Admin line 2 must stay a plain input')
    for (const [n, src] of [['profile', profile], ['dialog', dialog]] as const) {
      const uses = src.match(/<AddressSearchInput[\s\S]*?\/>/g) || []
      eq(uses.length, 1, `${n}: one search input`)
      ok(!/addressLine2|addr2/.test(uses[0] || ""), `${n}: search input must not be line 2`)
    }
  })
  await check('the Profile route saves through the writer with the pick checked against the box', () => {
    ok(/saveRestaurantAddress\(ref, await partsFromOneLine\(address, addressLine2\), pickedCoords\(body\?\.addressPick, address\)\)/.test(profileRoute), 'disco-profile PUT')
    ok(/requireWritableRestaurantRef\(body\?\.restaurant_reference\)/.test(profileRoute), 'disco-profile keeps its write-scope check')
  })
  await check('Super Admin: the pick is stripped before any FM merge and used only on the native branch', () => {
    const strip = adminRoute.indexOf('delete incoming.addressPick')
    ok(strip > 0 && strip < adminRoute.indexOf('deepMerge(existing, incoming)'), 'addressPick must be deleted before deepMerge')
    ok(strip < adminRoute.indexOf('isCurrentlyNative(ref)', adminRoute.indexOf('export async function PUT')), 'and before the native branch')
    ok(/saveRestaurantAddress\(ref, \{[^}]*\}, pickedCoords\(addressPick, typed\)\)/.test(adminRoute), 'native branch passes the pick to the writer')
  })
  await check('no second address writer: only lib/restaurant-address.ts UPDATEs address_line1', () => {
    for (const [n, src] of [['profile route', profileRoute], ['admin route', adminRoute]] as const) ok(!/address_line1\s*=/.test(src), `${n} writes address_line1 directly`)
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main()
