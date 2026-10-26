// Source guards for the GA4 search_performed (homepage) and add_to_cart (restaurant page) events.
// Run: npx tsx scripts/tests/ga4-search-add-to-cart.test.ts
//
//   1. HomeClient: one raw search_performed call, inside a once-per-page-view helper, called at all
//      three exits (suggestion picked, cuisine word, typed place that geocoded). No search text.
//   2. RestaurantClient: one add_to_cart call in addItemWithConfig, after the cross-menu return,
//      under track && !isDirectEntry, with value/currency, and the reorder call passes track=false.
//      No note or add-on names. Each control-tested against a doctored copy of the file.
import { readFileSync } from 'node:fs'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const count = (s: string, needle: string) => s.split(needle).length - 1

const HOME = readFileSync('app/(customer)/HomeClient.tsx', 'utf8')
const REST = readFileSync('app/(customer)/restaurants/[slug]/RestaurantClient.tsx', 'utf8')

function homeProblems(s: string): string[] {
  const out: string[] = []
  if (count(s, "trackEvent('search_performed'") !== 1) out.push('raw search_performed calls != 1')
  const fn = s.slice(s.indexOf('function trackSearchOnce'), s.indexOf('function trackSearchOnce') + 400)
  if (!fn.includes('if (searchSentRef.current) return') || !fn.includes('searchSentRef.current = true')) out.push('once-per-page-view ref missing')
  if (!fn.includes("surface: 'homepage', search_type: searchType, selection")) out.push('params wrong')
  if (/search_term|query|address|label/.test(fn.slice(fn.indexOf('trackEvent(')))) out.push('search text in event')
  for (const [call, before, after] of [
    ["trackSearchOnce('place', 'suggestion')", "const label =", "router.push(`/fullmap?lat=${lat}"],
    ["trackSearchOnce('cuisine', 'typed')", 'isCuisineQuery(query', "router.push(`/fullmap?search="],
    ["trackSearchOnce('place', 'typed')", 'if (hit) {', "router.push(`/fullmap?lat=${hit.lat}"],
  ] as const) {
    const c = s.indexOf(call), b = s.indexOf(before, s.indexOf('addListener')), a = s.indexOf(after)
    if (count(s, call) !== 1 || c < b || c > a) out.push(`${call} not at its exit`)
  }
  return out
}
function restProblems(s: string): string[] {
  const out: string[] = []
  if (count(s, "trackEvent('add_to_cart'") !== 1) out.push('raw add_to_cart calls != 1')
  const fnStart = s.indexOf('function addItemWithConfig')
  const call = s.indexOf("trackEvent('add_to_cart'")
  const blockReturn = s.indexOf('setCartBlockMessage(SEPARATE_MENU_MESSAGE)', fnStart)
  if (!(call > blockReturn && blockReturn > fnStart && call < s.indexOf('setCart(prev', blockReturn))) out.push('not after the cross-menu return and before setCart')
  if (!s.slice(call - 80, call).includes('if (track && !isDirectEntry)')) out.push('not guarded by track && !isDirectEntry')
  const body = s.slice(call, s.indexOf('})', call))
  for (const k of ['restaurant_name', 'restaurant_slug', 'item_name: pkg.name', 'item_id: pkg.reference', 'quantity: addQty', 'value: Math.round(unitPrice * addQty * 100) / 100', "currency: 'USD'", 'source: isFirstParty']) if (!body.includes(k)) out.push(`missing ${k}`)
  if (/note|addOns|add_on/.test(body)) out.push('note or add-on in event')
  if (count(s, 'pkg.price + extra, false)') !== 1) out.push('reorder call does not pass track=false')
  if (count(s, 'unitPrice: number, track = true)') !== 1) out.push('track parameter missing')
  return out
}

console.log('\n=== HomeClient search_performed ===')
check('one raw call, once-per-page-view, three exits, no search text', () => eq(homeProblems(HOME), [], 'problems'))
check('CONTROL: a removed exit call is caught', () => {
  eq(homeProblems(HOME.replace("trackSearchOnce('cuisine', 'typed')", '')).length > 0, true, 'doctored')
})
check('CONTROL: search text added to the event is caught', () => {
  eq(homeProblems(HOME.replace("surface: 'homepage',", "surface: 'homepage', search_term: address,")).length > 0, true, 'doctored')
})
check('CONTROL: a dropped once-per-page-view ref is caught', () => {
  eq(homeProblems(HOME.replace('if (searchSentRef.current) return', '')).length > 0, true, 'doctored')
})

console.log('\n=== RestaurantClient add_to_cart ===')
check('one call after the cross-menu return, under track && !isDirectEntry, no note or add-ons', () => eq(restProblems(REST), [], 'problems'))
check('CONTROL: dropping the Direct Entry guard is caught', () => {
  eq(restProblems(REST.replace('if (track && !isDirectEntry)', 'if (track)')).length > 0, true, 'doctored')
})
check('CONTROL: the call moved before the cross-menu return is caught', () => {
  const m = REST.match(/    \/\/ GA4 add_to_cart[\s\S]*?\n    }\n(?=    setCart\(prev)/)!
  const moved = REST.replace(m[0], '').replace('    if (isNewLine && cart.length > 0', m[0] + '    if (isNewLine && cart.length > 0')
  eq(restProblems(moved).length > 0, true, 'doctored')
})
check('CONTROL: a reorder call that tracks is caught', () => {
  eq(restProblems(REST.replace('pkg.price + extra, false)', 'pkg.price + extra)')).length > 0, true, 'doctored')
})
check('CONTROL: a note in the event is caught', () => {
  eq(restProblems(REST.replace("currency: 'USD',\n          source", "currency: 'USD', note,\n          source")).length > 0, true, 'doctored')
})

console.log(`\n${failures.length ? `FAILED ${failures.length} of ${passed + failures.length}` : `ALL PASS ${passed}`}`)
if (failures.length) process.exit(1)
