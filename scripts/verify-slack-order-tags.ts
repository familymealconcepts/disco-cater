/**
 * Renders the Slack new-order line for every service type x direct-entry
 * combination, from the REAL builder (buildNewOrderSlackText), and asserts the
 * service tag is wrapped exactly once.
 *
 * Written because the '((P))' double-wrap shipped unnoticed: fulfillmentTag
 * returns '(P)' already bracketed, and the template wrapped it a second time.
 * Nothing could exercise the rendered string, so nothing caught it. The assertion
 * below is the guard -- it fails on '((' or '))' anywhere in the line.
 *
 *   npx tsx scripts/verify-slack-order-tags.ts
 */
import { buildNewOrderSlackText } from '../lib/order-notifications'
import { fulfillmentLabel, fulfillmentTag } from '../lib/order/fulfillment-label'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ` — ${detail}`}`)
}

// The three delivery_type values that reach the three labels, as production holds them.
const SERVICES: Array<{ name: string; deliveryType: string | null; orderType: string }> = [
  { name: 'Pickup',               deliveryType: 'PICKUP',               orderType: 'PICKUP' },
  { name: 'Self-Delivery',        deliveryType: 'OWN_DELIVERY',         orderType: 'DELIVERY' },
  { name: 'Third-Party Delivery', deliveryType: 'THIRD_PARTY_DELIVERY', orderType: 'DELIVERY' },
]

console.log('=== the eight combinations, as they will post ===\n')
for (const s of SERVICES) {
  for (const de of [false, true]) {
    const label = fulfillmentLabel(s.deliveryType, s.orderType)
    const text = buildNewOrderSlackText({
      sourceOfOrder: 'FAMILYMEAL',
      restaurantName: 'Apollo Bagels - Tribeca',
      city: 'New York', state: 'NY',
      total: 855.64,
      orderDateIso: '2026-09-25',
      serviceLabel: label,
      isDirectEntry: de,
    })
    console.log(`   ${(s.name + (de ? ' + direct entry' : '')).padEnd(38)} ${text}`)
    check(`  no doubled bracket`, !text.includes('((') && !text.includes('))'), text)
    check(`  carries ${fulfillmentTag(label)} exactly once`,
      text.split(fulfillmentTag(label)).length - 1 === 1, text)
    check(`  (DE) ${de ? 'present and space-separated' : 'absent'}`,
      de ? text.includes(`${fulfillmentTag(label)} (DE)`) : !text.includes('(DE)'), text)
  }
}

// A label fulfillmentTag does not recognise must still bracket exactly once.
console.log('\n=== unrecognised label falls back, still wrapped once ===')
const odd = buildNewOrderSlackText({
  sourceOfOrder: 'DISCO', restaurantName: 'Test', city: 'Akron', state: 'OH',
  total: 10, orderDateIso: '2026-09-18',
  serviceLabel: 'Something New', isDirectEntry: false,
})
console.log('   ' + odd)
check('  unrecognised label wrapped once', odd.includes('- (Something New)') && !odd.includes('(('), odd)

const empty = buildNewOrderSlackText({
  sourceOfOrder: 'DISCO', restaurantName: 'Test', city: '', state: '',
  total: 0, orderDateIso: '2026-09-18',
  serviceLabel: '', isDirectEntry: false,
})
console.log('   ' + empty)
check('  empty label renders (Unknown), wrapped once', empty.includes('- (Unknown)') && !empty.includes('(('), empty)

console.log('\n' + '='.repeat(64))
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
