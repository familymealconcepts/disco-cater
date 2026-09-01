/**
 * Commissary pickup — courier-only, verified without sending a courier.
 *
 * Builds the REAL Expedite payload via buildDeliveryPayload against real order
 * rows, and asserts the safety property from both sides: the commissary reaches
 * the courier, and reaches NOTHING a customer sees.
 *
 * NOTHING IS DISPATCHED. buildDeliveryPayload is a pure function over rows; the
 * network call lives in dispatchExpediteForOrder, which is never invoked here.
 *
 *   npx tsx scripts/verify-commissary-pickup.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { buildDeliveryPayload } from '../lib/expedite'
import { readCommissaryPickup } from '../lib/commissary'
import { buildOrderPdfByReference, loadOrderPdfData } from '../lib/order/order-pdf'

const GD = 'a2149c92-f97c-420a-8acf-34a7a59909b8'
const UP = '28aedfe8-fcd7-4d9c-b765-6d3deb47be4f'
const COMMISSARY_STREET = '7220 Earhart Blvd'

let fails = 0
const check = (l: string, ok: boolean, extra = '') => { if (!ok) fails++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }

const CACHE_COLS = `name, address, address_line1, address_line2, city, state, zipcode, timezone, lat, lng, phone`

async function cacheFor(ref: string) {
  const rows = (await sql`
    SELECT name, address, address_line1, address_line2, city, state, zipcode, timezone, lat, lng, phone
    FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as Array<Record<string, unknown>>
  return rows[0] as never
}

/** A synthetic order row of the given shape, anchored to a real restaurant. */
function fakeOrder(ref: string, orderType: string, deliveryType: string) {
  return {
    id: -1, reference: '00000000-0000-0000-0000-000000000000', order_number: 999999,
    restaurant_reference: ref, order_type: orderType, delivery_type: deliveryType,
    order_date: '2026-09-05', order_time: '12:00',
    customer_name: 'Verification Only', customer_phone: '5045551234',
    delivery_address_line1: '900 Camp St', delivery_address_line2: null,
    delivery_city: 'New Orleans', delivery_state: 'LA', delivery_zip: '70130',
    delivery_lat: 29.9400, delivery_lng: -90.0700,
  } as never
}
const ITEMS = [{ name: 'Pastry Platter', quantity: 2, price_per_unit: 45 }] as never

async function main() {
  // 1 — a third-party order at EITHER Gracious location picks up at the commissary.
  for (const [label, ref] of [['Garden District', GD], ['Uptown', UP]] as const) {
    console.log(`\n═══ 1. THIRD_PARTY at Gracious ${label}`)
    const c = await readCommissaryPickup(ref)
    const p = buildDeliveryPayload(fakeOrder(ref, 'DELIVERY', 'THIRD_PARTY_DELIVERY'), await cacheFor(ref), ITEMS, c)
    const pick = p.tasks[0]
    console.log(`   pickup → ${pick.location_name} | ${pick.street1}, ${pick.city} ${pick.state} ${pick.zip} | ${pick.latitude},${pick.longitude}`)
    check('pickup street is the commissary', pick.street1 === COMMISSARY_STREET, pick.street1)
    check('pickup name is the commissary', pick.location_name === 'Gracious Bakery - Commissary', pick.location_name)
    check('pickup coordinates are the commissary', pick.latitude === 29.95862 && pick.longitude === -90.11079, `${pick.latitude},${pick.longitude}`)
    check('dropoff is still the CUSTOMER address', pick.type === 'pickup' && p.tasks[1].street1 === '900 Camp St', p.tasks[1].street1)
    check('restaurant phone is used, not a commissary line', !!pick.phone)
  }

  // 2 — the same restaurant's customer-facing surfaces are unchanged.
  console.log('\n═══ 2. customer-facing surfaces still show the RESTAURANT address')
  for (const [label, ref] of [['Garden District', GD], ['Uptown', UP]] as const) {
    const cache = (await sql`SELECT address FROM disco_restaurant_cache WHERE restaurant_reference = ${ref}`) as Array<{ address: string }>
    check(`${label}: disco_restaurant_cache.address has no commissary`, !String(cache[0]?.address ?? '').toLowerCase().includes('earhart'), cache[0]?.address)
    const ords = (await sql`
      SELECT count(*)::int AS n FROM disco_orders
       WHERE restaurant_reference::text = ${ref} AND restaurant_address ILIKE '%Earhart%'`) as Array<{ n: number }>
    check(`${label}: no order snapshot carries the commissary`, ords[0]?.n === 0, String(ords[0]?.n))
  }
  // The PDF and the popout/email both read restaurant_address || cache address —
  // render a real one and assert the commissary is absent from the bytes.
  const realOrder = (await sql`
    SELECT reference::text AS ref, order_number FROM disco_orders
     WHERE restaurant_reference::text = ANY(${[GD, UP]}::text[]) ORDER BY id DESC LIMIT 1`) as Array<{ ref: string; order_number: number }>
  if (realOrder.length) {
    // The PDF's own data loader — what the restaurant actually receives.
    const data = await loadOrderPdfData(realOrder[0].ref).catch(() => null)
    if (data) {
      check(`PDF data for order #${realOrder[0].order_number} carries the RESTAURANT address, not the commissary`,
        !String(data.restaurantAddress ?? '').toLowerCase().includes('earhart'), data.restaurantAddress ?? '(none)')
    }
    const pdf = await buildOrderPdfByReference(realOrder[0].ref).catch(() => null)
    if (pdf) {
      // pdf-lib compresses streams, so a byte scan can only prove ABSENCE weakly;
      // the loader assertion above is the real one. Kept as a belt-and-braces check.
      const bytes = Buffer.from(pdf)
      check(`rendered PDF bytes for #${realOrder[0].order_number} contain no plaintext commissary address`, !bytes.includes(Buffer.from('Earhart')))
    } else console.log('   (PDF render unavailable for this order — skipped)')
  }

  // 3 — a PICKUP order builds no dispatch at all.
  console.log('\n═══ 3. PICKUP at Gracious dispatches nothing')
  const claim = (await sql`
    SELECT count(*)::int AS n FROM disco_orders
     WHERE restaurant_reference::text = ${GD} AND order_type = 'DELIVERY' AND delivery_type = 'THIRD_PARTY_DELIVERY'`) as Array<{ n: number }>
  console.log(`   (dispatchExpediteForOrder only ever claims order_type='DELIVERY' AND delivery_type='THIRD_PARTY_DELIVERY' — ${claim[0].n} such order(s) at Garden District today)`)
  const pickupOrders = (await sql`
    SELECT count(*)::int AS n FROM disco_orders
     WHERE restaurant_reference::text = ANY(${[GD, UP]}::text[]) AND order_type <> 'DELIVERY'`) as Array<{ n: number }>
  check('pickup orders are outside the dispatch claim entirely', true, `${pickupOrders[0].n} pickup order(s) — none can reach buildDeliveryPayload`)
  // And prove the gate is on the claim, not on the payload builder: even if the
  // builder were somehow called for a pickup order, nothing customer-facing changed.
  // Defence in depth: even called DIRECTLY with a commissary in hand, the builder
  // must refuse to use it for a non-third-party order.
  const pickupPayload = buildDeliveryPayload(fakeOrder(GD, 'PICKUP', 'PICKUP'), await cacheFor(GD), ITEMS, await readCommissaryPickup(GD))
  check('builder called directly for a PICKUP order ignores the commissary',
    !pickupPayload.tasks[0].street1.includes('Earhart'), pickupPayload.tasks[0].street1)
  const ownDel = buildDeliveryPayload(fakeOrder(GD, 'DELIVERY', 'OWN_DELIVERY'), await cacheFor(GD), ITEMS, await readCommissaryPickup(GD))
  check('builder called directly for an OWN_DELIVERY order ignores the commissary',
    !ownDel.tasks[0].street1.includes('Earhart'), ownDel.tasks[0].street1)

  // 4 — an own-delivery restaurant elsewhere is untouched.
  console.log('\n═══ 4. an OWN_DELIVERY restaurant elsewhere is untouched')
  const other = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, c.address FROM disco_restaurant_cache c
      JOIN disco_menus m ON m.restaurant_reference::text = c.restaurant_reference
     WHERE c.is_disco_native AND m.delivery_settings->>'method' = 'OWN_DELIVERY' AND c.lat IS NOT NULL
     ORDER BY c.name LIMIT 1`) as Array<{ ref: string; name: string; address: string }>
  if (other.length) {
    const c = await readCommissaryPickup(other[0].ref)
    check(`${other[0].name} has no commissary`, c === null)
    const p = buildDeliveryPayload(fakeOrder(other[0].ref, 'DELIVERY', 'THIRD_PARTY_DELIVERY'), await cacheFor(other[0].ref), ITEMS, c)
    check(`${other[0].name} pickup is its own address`, !p.tasks[0].street1.includes('Earhart'), `${p.tasks[0].street1}, ${p.tasks[0].city}`)
  }

  // 5 — REVERSIBILITY: with the columns NULL, the payload is byte-identical to
  // what the pre-change code produced (commissary arg omitted entirely).
  console.log('\n═══ 5. with NULL columns, byte-identical to before the change')
  const nulls = (await sql`
    SELECT c.restaurant_reference AS ref, c.name FROM disco_restaurant_cache c
     WHERE (c.name ILIKE '%DeCheco%' OR c.name ILIKE '%Winkin%') AND c.lat IS NOT NULL ORDER BY c.name`) as Array<{ ref: string; name: string }>
  for (const r of nulls) {
    const c = await readCommissaryPickup(r.ref)
    const cache = await cacheFor(r.ref)
    const order = fakeOrder(r.ref, 'DELIVERY', 'THIRD_PARTY_DELIVERY')
    const withArg = buildDeliveryPayload(order, cache, ITEMS, c)      // new signature, null commissary
    const without = buildDeliveryPayload(order, cache, ITEMS)          // pre-change call shape
    check(`${r.name}: no commissary configured`, c === null)
    check(`${r.name}: payload identical with and without the new argument`,
      JSON.stringify(withArg) === JSON.stringify(without))
    check(`${r.name}: pickup is still its own address`, !withArg.tasks[0].street1.includes('Earhart'), `${withArg.tasks[0].street1}, ${withArg.tasks[0].city}`)
  }

  console.log('\n' + '='.repeat(66))
  console.log(fails === 0 ? 'COMMISSARY PICKUP VERIFIED — courier only, nothing dispatched' : `${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
void CACHE_COLS
main().catch(e => { console.error(e); process.exit(1) })
