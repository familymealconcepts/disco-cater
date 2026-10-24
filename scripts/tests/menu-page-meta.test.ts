// Fixtures for the menu-page title and description rule (lib/restaurant-seo.ts), approved word for
// word by Kevin on 2026-10-23 (NM OS item #43). Run: npx tsx scripts/tests/menu-page-meta.test.ts
//
//   1. The exact strings approved for the top pages, pinned verbatim.
//   2. The rule's edges: no repeated city, the 60-character steps, the 155-character word cut, and
//      no "order online" promise when the restaurant cannot take an order.
//   3. Source guards: the page builds both through the module, passes orderability, and the no-data
//      fallback is unchanged. Control-tested against doctored copies.
import { readFileSync } from 'node:fs'
import { menuPageTitle, menuPageDescription, cutAtWord, MAX_TITLE, MAX_DESCRIPTION } from '../../lib/restaurant-seo'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg = '') { if (a !== b) throw new Error(`${msg}\n      got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`) }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg) }

console.log('\n=== the approved strings ===')
const APPROVED: Array<[string, string, string, string, string]> = [
  // name, location, blurb, title, description
  ["Fat Boy's Pizza - Fort Wayne", 'Fort Wayne, IN', 'Casual eatery serving extra-large pizzas, wings, salads and beer, plus gluten-free options.',
    "Fat Boy's Pizza - Fort Wayne Catering Menu | Disco Cater",
    "See the Fat Boy's Pizza - Fort Wayne catering menu and order online for your office, event or party. Casual eatery serving extra-large pizzas, wings…"],
  ['Club Sandwich', 'Tivoli, NY', 'breakfast + lunch + coffee + groceries',
    'Club Sandwich Catering Menu – Tivoli, NY | Disco Cater',
    'See the Club Sandwich catering menu and order online for your office, event or party. Breakfast + lunch + coffee + groceries.'],
  ['Lechon Loco', 'Tacoma, WA', 'Filipino & Latin fusion - quality ingredients, innovative dishes, and warm hospitality.',
    'Lechon Loco Catering Menu – Tacoma, WA | Disco Cater',
    'See the Lechon Loco catering menu and order online for your office, event or party. Filipino & Latin fusion - quality ingredients, innovative dishes, and…'],
  ["Maciel's Plant-Based Butcher & Deli", 'Los Angeles, CA', 'Plant-Based Meats, Sandwiches, Salads, Breakfast made in-house',
    "Maciel's Plant-Based Butcher & Deli Catering Menu",
    "See the Maciel's Plant-Based Butcher & Deli catering menu and order online for your office, event or party. Plant-Based Meats, Sandwiches, Salads…"],
  ['Wavershak\'s Deli and Grill', 'Toms River, NJ', 'Jersey shore family-owned American grill serving all your favorite comfort foods.',
    "Wavershak's Deli and Grill Catering Menu – Toms River, NJ",
    "See the Wavershak's Deli and Grill catering menu and order online for your office, event or party. Jersey shore family-owned American grill serving all…"],
  ['Winfield Street Coffee - Stamford', 'Stamford, CT', 'Warm service, handcrafted coffee, and fresh breakfast and lunch served with consistency and care.',
    'Winfield Street Coffee - Stamford Catering Menu',
    'See the Winfield Street Coffee - Stamford catering menu and order online for your office, event or party. Warm service, handcrafted coffee, and fresh…'],
]
for (const [name, loc, blurb, title, desc] of APPROVED) {
  check(`${name}: title`, () => eq(menuPageTitle(name, loc), title))
  check(`${name}: description`, () => eq(menuPageDescription(name, loc, blurb, true), desc))
}

console.log('\n=== the rule ===')
check('the location is left out when the name already holds the city (any case)', () =>
  eq(menuPageTitle('Apollo Bagels - kips bay', 'Kips Bay, NY'), 'Apollo Bagels - kips bay Catering Menu | Disco Cater'))
check('a name with a different city keeps the location', () =>
  eq(menuPageTitle('Apollo Bagels - Williamsburg', 'Brooklyn, NY'), 'Apollo Bagels - Williamsburg Catering Menu – Brooklyn, NY'))
check('no location: just the name, menu and brand', () => eq(menuPageTitle('Katz', ''), 'Katz Catering Menu | Disco Cater'))
check('every title from a name under 40 characters fits in 60', () => {
  for (const n of ['A', 'A Very Long Restaurant Name For Testing', "Panatieri's Pizza & Pasta of Flemington"]) {
    const t = menuPageTitle(n, 'Somewhere Very Far Away, NJ')
    ok(t.length <= MAX_TITLE, `${t.length}: ${t}`)
  }
})
check('a name too long for anything keeps "{name} Catering Menu"', () => {
  const n = 'The Extraordinarily Long Name Of A Restaurant In Town'
  eq(menuPageTitle(n, 'Far, NJ'), `${n} Catering Menu`)
})
check('not orderable: no "order online" promise', () => {
  const d = menuPageDescription('Lechon Loco', 'Tacoma, WA', 'Filipino & Latin fusion.', false)
  eq(d, 'See the Lechon Loco catering menu on Disco Cater. Filipino & Latin fusion.')
  ok(!/order online/i.test(d), 'promises ordering')
})
check('no blurb, orderable', () =>
  eq(menuPageDescription('Lechon Loco', 'Tacoma, WA', null, true), 'See the Lechon Loco catering menu and order online for your office, event or party in Tacoma, WA, with Disco Cater.'))
check('no blurb, not orderable', () =>
  eq(menuPageDescription('Lechon Loco', 'Tacoma, WA', '  ', false), 'See the Lechon Loco catering menu on Disco Cater in Tacoma, WA.'))
check('no blurb and no location', () => {
  eq(menuPageDescription('Katz', '', null, true), 'See the Katz catering menu and order online for your office, event or party, with Disco Cater.')
  eq(menuPageDescription('Katz', '', null, false), 'See the Katz catering menu on Disco Cater.')
})
check('a blurb already ending in punctuation gets no second full stop', () =>
  eq(menuPageDescription('Ugly Duckling', 'Portland, ME', 'Tasty treats!', true), 'See the Ugly Duckling catering menu and order online for your office, event or party. Tasty treats!'))
check('every description fits in 155 and is cut at a word, never mid-word', () => {
  const d = menuPageDescription('X', 'Y, NJ', 'word '.repeat(80), true)
  ok(d.length <= MAX_DESCRIPTION && d.endsWith('word…'), `${d.length}: …${d.slice(-20)}`)
})
check('cutAtWord leaves a short string alone and trims trailing punctuation before the ellipsis', () => {
  eq(cutAtWord('short', 10), 'short')
  eq(cutAtWord('one two, three', 10), 'one two…')
})

console.log('\n=== source guards ===')
const shared = readFileSync('app/(customer)/restaurants/[slug]/shared.tsx', 'utf8')
const usesModule = (s: string) => /const title = menuPageTitle\(r\.name, loc\)/.test(s) && /menuPageDescription\(r\.name, loc, [^\n]*orderable\?\.reason === 'ok'\)/.test(s)
check('buildRestaurantMetadata builds both through lib/restaurant-seo.ts and passes orderability', () => ok(usesModule(shared), 'not using the module'))
check('  control: an inline title is caught', () => ok(!usesModule(shared.replace('const title = menuPageTitle(r.name, loc)', 'const title = `${r.name} — Catering | Disco Cater`')), 'not caught'))
check('  control: dropping orderability is caught', () => ok(!usesModule(shared.replace("orderable?.reason === 'ok')", 'true)')), 'not caught'))
check('the no-data fallback is unchanged (Kevin, 2026-10-23)', () =>
  ok(shared.includes("title: 'Catering | Disco Cater'") && shared.includes("description: 'Order catering on Disco Cater.'"), 'fallback changed'))
check('the old title template is gone', () => ok(!/— Catering in \$\{loc\}/.test(shared), 'old template still present'))

console.log(`\n${failures.length ? 'FAILED' : 'ALL PASS'} ${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join('; ')}` : ''}`)
if (failures.length) process.exit(1)
