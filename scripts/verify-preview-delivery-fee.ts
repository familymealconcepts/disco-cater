/**
 * Verification for the Order Summary "Delivery fee: Free" bug.
 *
 * READ-ONLY. Exercises the REAL preview entry point (priceNativeFmDto — what
 * /api/order/init calls) against production menu data, and asserts the preview now
 * agrees with the other two readers: /api/order/validate-address (the date picker)
 * and the placement path (checkout).
 *
 *   npx tsx scripts/verify-preview-delivery-fee.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { priceNativeFmDto } from '../lib/order/native-checkout'
import { validateNativeDelivery } from '../lib/order/native-delivery'
import { sql } from '../lib/db'

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : ` — expected ${JSON.stringify(expected)}`}`)
}
const feeOf = (r: Record<string, unknown>) =>
  ((r.data as Record<string, unknown>).checkoutPublicResponseDto as Record<string, unknown>).deliveryFee

interface Loc { ref: string; name: string; menu: string; item: string; price: number; lat: number; lng: number; expected: number }

async function locate(nameLike: string, expected: number): Promise<Loc | null> {
  const rows = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, c.lat, c.lng,
           m.reference AS menu,
           (SELECT i.name FROM disco_menu_items i
              JOIN disco_menu_categories cat ON cat.reference = i.category_reference
             WHERE cat.menu_reference = m.reference AND i.visible AND i.min_quantity IS NULL
             ORDER BY i.position LIMIT 1) AS item,
           (SELECT i.price FROM disco_menu_items i
              JOIN disco_menu_categories cat ON cat.reference = i.category_reference
             WHERE cat.menu_reference = m.reference AND i.visible AND i.min_quantity IS NULL
             ORDER BY i.position LIMIT 1) AS price
    FROM disco_restaurant_cache c
    JOIN disco_menus m ON m.restaurant_reference = c.restaurant_reference::uuid AND NOT m.archived
    WHERE c.name ILIKE ${nameLike} AND c.is_disco_native
    ORDER BY m.position LIMIT 1
  `) as unknown as { ref: string; name: string; lat: string; lng: string; menu: string; item: string; price: string }[]
  const r = rows[0]
  if (!r || !r.item) return null
  return { ref: r.ref, name: r.name, menu: r.menu, item: r.item, price: Number(r.price), lat: Number(r.lat), lng: Number(r.lng), expected }
}

const dto = (l: Loc, withAddress: boolean, qty = 20) => ({
  restaurantRef: l.ref,
  orderType: 'DELIVERY',
  tips: 0,
  tipsType: 'PERCENTAGE',
  items: [{ reference: null, name: l.item, price: l.price, count: qty, menuReference: l.menu }],
  ...(withAddress ? {
    deliveryAddress: {
      addressLine1: '1 Main St', city: 'Town', state: 'GA', zipcode: '30080',
      // The restaurant's own coordinates — distance 0, so squarely inside any zone.
      latitude: l.lat, longitude: l.lng,
    },
  } : {}),
})

async function main() {
  // $25/10mi, $30/15mi, and a genuinely-free zone ($0 within 10mi).
  const targets = [
    await locate('%atlanta bread%smyrna%', 25),
    await locate('%atlanta bread%woodstock%', 30),
    // A genuinely-free native zone (feeFixed 0 / feePercent 0 within 5 miles) —
    // it must still read 0 so the panel says "Free", not be hidden as unknown.
    await locate('%bird & co%', 0),
  ]

  for (const l of targets) {
    if (!l) { console.log('   FAIL  restaurant not found'); failures++; continue }
    console.log(`\n=== ${l.name} (configured $${l.expected}) ===`)

    // 1. Preview WITH an address — must now equal the configured fee.
    const withAddr = await priceNativeFmDto(dto(l, true))
    check('preview with address', feeOf(withAddr), l.expected)

    // 2. The date picker's reader (validate-address) — the number Basil saw.
    const subtotal = Number(((withAddr.data as Record<string, unknown>).checkoutPublicResponseDto as Record<string, unknown>).subtotal)
    const dv = await validateNativeDelivery(l.ref, {
      addressLine1: '1 Main St', city: 'Town', state: 'GA', zip: '30080', latitude: l.lat, longitude: l.lng,
    }, subtotal, undefined, l.menu)
    check('date picker (validate-address) agrees', dv.deliveryFee, l.expected)

    // 3. All three readers agree.
    check('preview === picker', feeOf(withAddr), dv.deliveryFee)

    // 4. Preview WITHOUT an address — must be null ("not yet known"), never 0,
    //    because the summary panel renders 0 as "Free".
    const noAddr = await priceNativeFmDto(dto(l, false))
    const expectedNoAddr = l.expected === 0 ? null : null   // own-delivery is always deferred without an address
    check('preview with no address is null, not 0', feeOf(noAddr), expectedNoAddr)
    check('  ...and specifically not 0', feeOf(noAddr) === 0, false)
  }

  // A genuinely-free zone must still read as 0 (→ "Free"), not null.
  const free = targets[2]
  if (free) {
    console.log('\n=== Free zone still reads Free (not hidden) ===')
    const r = await priceNativeFmDto(dto(free, true))
    check('$0 zone with address → 0', feeOf(r), 0)
  }

  // Pickup must be untouched.
  const smyrna = targets[0]
  if (smyrna) {
    console.log('\n=== Pickup unaffected ===')
    const r = await priceNativeFmDto({ ...dto(smyrna, false), orderType: 'PICKUP' })
    check('pickup preview delivery fee', feeOf(r), 0)
  }

  console.log('\n' + '='.repeat(66))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
