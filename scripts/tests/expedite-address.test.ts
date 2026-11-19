// Guards for the courier pickup address (lib/expedite.ts buildDeliveryPayload, parseAddress).
// Run: npx tsx scripts/tests/expedite-address.test.ts
//
// #900001635 (Rosemary's East): the restaurant's stored row had a street but no zipcode, so the pickup went to
// Expedite with zip "" and was refused 90 times ("order's task does not contain value of 'zip'"). A missing
// structured part is now filled from the single-line address, which also parses "…, NY, 10010".
import { buildDeliveryPayload, parseAddress } from '../../lib/expedite'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const order = {
  reference: '3c2412f6-5194-4cef-ac97-d0c850a1c53f', fm_order_reference: null, order_date: '2026-11-24', order_time: '10:00:00',
  delivery_type: 'THIRD_PARTY_DELIVERY', order_type: 'DELIVERY', customer_first_name: 'A', customer_last_name: 'B', customer_phone: '2125550100',
  delivery_address_line1: '5 Avenue A', delivery_address_line2: '', delivery_city: 'New York', delivery_state: 'NY', delivery_zip: '10009',
  delivery_lat: 40.7225634, delivery_lng: -73.9864693, subtotal: 100, tips: 10, delivery_instructions: null,
} as unknown as Parameters<typeof buildDeliveryPayload>[0]
const cache = (o: Record<string, unknown>) => ({ name: 'Rosemary’s East', timezone: 'America/New_York', lat: 40.7338, lng: -73.9802, phone: '2125550199', ...o }) as unknown as Parameters<typeof buildDeliveryPayload>[1]
const pickup = (c: Parameters<typeof buildDeliveryPayload>[1]) => {
  const t = buildDeliveryPayload(order, c, [], null).tasks.find((x) => x.type === 'pickup')!
  return { street1: t.street1, city: t.city, state: t.state, zip: t.zip }
}

console.log('\n=== Expedite pickup address ===')
check('parse: the usual form and the comma-before-zip form', () => {
  eq(parseAddress('123 Main St, Nashville, TN 37201'), { street1: '123 Main St', city: 'Nashville', state: 'TN', zip: '37201' }, 'usual')
  eq(parseAddress('350 1st Avenue, New York, NY, 10010'), { street1: '350 1st Avenue', city: 'New York', state: 'NY', zip: '10010' }, 'comma before zip')
  eq(parseAddress('201 Willett Avenue, Port Chester, NY, 10573-1234').zip, '10573', 'zip+4')
  eq(parseAddress('1 Main St, Somewhere').zip, '', 'no zip anywhere stays empty')
})
check('#900001635: a street with no zipcode takes the zip from the single-line address', () => {
  eq(pickup(cache({ address: '350 1st Avenue, New York, NY, 10010', address_line1: '350 1st Avenue', city: 'New York', state: 'NY', zipcode: null })),
    { street1: '350 1st Avenue', city: 'New York', state: 'NY', zip: '10010' }, 'pickup')
})
check('a missing city or state is filled too; a value the row has is never replaced', () => {
  eq(pickup(cache({ address: '201 Willett Avenue, Port Chester, NY 10573', address_line1: '201 Willett Avenue', city: '', state: null, zipcode: null })),
    { street1: '201 Willett Avenue', city: 'Port Chester', state: 'NY', zip: '10573' }, 'filled')
  eq(pickup(cache({ address: '9 Old St, Oldtown, NJ 07001', address_line1: '350 1st Ave', city: 'New York', state: 'ny', zipcode: '10010' })),
    { street1: '350 1st Ave', city: 'New York', state: 'NY', zip: '10010' }, 'the structured row wins')
})
check('no street at all: the single-line address is parsed, as before', () => {
  eq(pickup(cache({ address: '825 Third Ave, New York, NY 10022', address_line1: null })), { street1: '825 Third Ave', city: 'New York', state: 'NY', zip: '10022' }, 'parsed')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
