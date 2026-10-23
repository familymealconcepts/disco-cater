// Guards for the GA4 checkout_completed conversion (lib/checkout-conversion.ts) and its two call
// sites in CheckoutDrawer. Run: npx tsx scripts/tests/checkout-conversion.test.ts
//
//   1. The charged total is read off every shape /api/order/place returns, in the route's own order.
//   2. Only an absent charged total falls back to the estimate, and the source says which.
//   3. The once-per-order guard: once per order, independent per order, and FAILS OPEN when storage
//      is missing or throws (a dropped real conversion is worse than a double-count).
//   4. Source guards: both checkout_completed calls go through the helper, and the helper sends
//      transaction_id, value and currency. Each control-tested against a doctored copy of the file.
import { readFileSync } from 'node:fs'
import { chargedTotalFromPlace, conversionValue, firstConversionForOrder, CONVERSION_SENT_PREFIX } from '../../lib/checkout-conversion'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

console.log('\n=== charged total from the place response ===')
check('native: breakdown.total, in dollars', () => eq(chargedTotalFromPlace({ native: true, breakdown: { total: 205.2, transfer: 180 } }), 205.2, 'native'))
check('native with no breakdown total is unknown, never another field', () =>
  eq(chargedTotalFromPlace({ native: true, taxExemptCharge: 9, data: { total: 7 } }), null, 'native ignores FM fields'))
check('FM: restaurant promo charge wins (applied after tax exemption)', () =>
  eq(chargedTotalFromPlace({ restaurantPromoCharge: 150.5, taxExemptCharge: 190, data: { checkoutPublicResponseDto: { total: 205.2 } } }), 150.5, 'promo'))
check('FM: tax-exempt charge next', () => eq(chargedTotalFromPlace({ taxExemptCharge: 190, data: { total: 205.2 } }), 190, 'exempt'))
check('FM: total under data.checkoutPublicResponseDto', () => eq(chargedTotalFromPlace({ data: { checkoutPublicResponseDto: { total: 205.2 } } }), 205.2, 'dto'))
check('FM: total directly under data, and string totals', () => eq(chargedTotalFromPlace({ data: { total: '99.95' } }), 99.95, 'data.total'))
check('FM: totalAmount / transactionsTotal, the route extractMoney fallbacks', () => {
  eq(chargedTotalFromPlace({ data: { totalAmount: 12 } }), 12, 'totalAmount')
  eq(chargedTotalFromPlace({ data: { transactionsTotal: 13 } }), 13, 'transactionsTotal')
})
check('no usable total is unknown, not 0', () => {
  for (const r of [null, undefined, {}, { data: {} }, { data: { total: 'abc' } }, { data: { total: -5 } }, { native: true }]) eq(chargedTotalFromPlace(r as never), null, JSON.stringify(r))
})

console.log('\n=== value and its source ===')
check('charged total used and labelled charged', () => eq(conversionValue({ data: { total: 205.2 } }, 210), { value: 205.2, source: 'charged' }, 'charged'))
check('estimate only when the response says nothing, labelled estimate', () => eq(conversionValue({}, 210.456), { value: 210.46, source: 'estimate' }, 'estimate'))
check('a charged 0 is a real charge, not a reason to fall back', () => eq(conversionValue({ data: { total: 0 } }, 50), { value: 0, source: 'charged' }, 'zero'))

console.log('\n=== once per order ===')
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m } }
check('first call fires, the second for the same order does not', () => {
  const s = mem()
  eq([firstConversionForOrder('900123', s), firstConversionForOrder('900123', s)], [true, false], 'repeat')
  eq(s.m.has(CONVERSION_SENT_PREFIX + '900123'), true, 'stored under the prefix')
})
check('a different order still fires', () => {
  const s = mem(); firstConversionForOrder('1', s)
  eq(firstConversionForOrder('2', s), true, 'other order')
})
check('fails open: no storage, throwing storage, empty id', () => {
  eq(firstConversionForOrder('3', null), true, 'null store')
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  eq(firstConversionForOrder('3', boom), true, 'throwing store')
  eq(firstConversionForOrder('', mem()), true, 'empty id')
})

console.log('\n=== source guards (CheckoutDrawer) ===')
const DRAWER = 'app/(customer)/restaurants/[slug]/CheckoutDrawer.tsx'
const src = readFileSync(DRAWER, 'utf8')
const rawCalls = (s: string) => (s.match(/trackEvent\('checkout_completed'/g) ?? []).length
const helperCalls = (s: string) => (s.match(/trackCheckoutCompleted\(placedOrderNumber \?\? finalRef, /g) ?? []).length
check('exactly one raw checkout_completed call, inside the helper', () => eq(rawCalls(src), 1, 'raw calls'))
check('both completion points call the helper', () => eq(helperCalls(src), 2, 'helper calls'))
check('the helper sends transaction_id, value and currency USD, guarded once per order', () => {
  const fn = src.slice(src.indexOf('function trackCheckoutCompleted'), src.indexOf("trackEvent('checkout_completed'") + 600)
  for (const s of ['transaction_id: transactionId', 'value,', "currency: 'USD'", 'firstConversionForOrder(transactionId']) if (!fn.includes(s)) throw new Error(`missing ${s}`)
})
check('CONTROL: a second raw call (the pre-change shape) is caught', () => {
  const doctored = src.replace('trackCheckoutCompleted(placedOrderNumber ?? finalRef, placeData)', "trackEvent('checkout_completed', {})")
  eq(rawCalls(doctored), 2, 'raw calls in doctored copy')
  eq(helperCalls(doctored), 1, 'helper calls in doctored copy')
})

console.log(`\n${failures.length ? `FAILED ${failures.length} of ${passed + failures.length}` : `ALL PASS ${passed}`}`)
if (failures.length) process.exit(1)
