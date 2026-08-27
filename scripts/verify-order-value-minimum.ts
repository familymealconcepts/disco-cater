/**
 * Verification for the order-VALUE minimum gate (loadMenuOrderMinimums, enforced in
 * buildNativePlaceInput).
 *
 * Read-only. Exercises the REAL loader against REAL production menu data and applies
 * the gate's exact predicate, for the cases named in the brief:
 *   • Bird & Co.  — refuses a $249 delivery cart, accepts $250
 *   • Asheville   — accepts ANY pickup subtotal (minimum 0), refuses delivery < $200
 *   • plus: no valid order breaks, and add-ons count toward the subtotal
 *
 *   npx tsx scripts/verify-order-value-minimum.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { loadMenuOrderMinimums, cartSubtotal, type NativeCartItem } from '../lib/order/native-checkout'
import { sql } from '../lib/db'

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : ` — expected ${JSON.stringify(expected)}`}`)
}

/** The gate's predicate, byte-for-byte as buildNativePlaceInput applies it. */
const refused = (mins: { pickup: number; delivery: number }, orderType: 'PICKUP' | 'DELIVERY', items: NativeCartItem[]) => {
  const minForType = orderType === 'DELIVERY' ? mins.delivery : mins.pickup
  if (minForType <= 0) return false
  return cartSubtotal(items) < minForType
}

/** A single cart line at an exact subtotal (quantity 1 keeps the arithmetic obvious). */
const cartAt = (subtotal: number): NativeCartItem[] => [{ name: 'Test line', price: subtotal, quantity: 1 }]

async function refFor(nameLike: string): Promise<{ ref: string; name: string; menu: string } | null> {
  const rows = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, m.reference AS menu
    FROM disco_restaurant_cache c
    JOIN disco_menus m ON m.restaurant_reference = c.restaurant_reference::uuid AND NOT m.archived
    WHERE c.name ILIKE ${nameLike} AND c.is_disco_native
    ORDER BY m.position, m.id LIMIT 1
  `) as unknown as { ref: string; name: string; menu: string }[]
  return rows[0] ?? null
}

async function main() {
  // ── Bird & Co. — $250 both ways ────────────────────────────────────────────
  const bird = await refFor('%bird & co%')
  console.log('\n=== Bird & Co. (expect $250 delivery minimum) ===')
  if (!bird) { console.log('   FAIL  restaurant not found'); failures++ } else {
    const mins = await loadMenuOrderMinimums(bird.ref, bird.menu)
    console.log(`   ${bird.name} — pickup $${mins.pickup.toFixed(2)}, delivery $${mins.delivery.toFixed(2)}`)
    check('delivery minimum', mins.delivery, 250)
    check('$249.00 delivery refused', refused(mins, 'DELIVERY', cartAt(249)), true)
    check('$249.99 delivery refused', refused(mins, 'DELIVERY', cartAt(249.99)), true)
    check('$250.00 delivery accepted', refused(mins, 'DELIVERY', cartAt(250)), false)
    check('$250.01 delivery accepted', refused(mins, 'DELIVERY', cartAt(250.01)), false)
    check('$1000 delivery accepted', refused(mins, 'DELIVERY', cartAt(1000)), false)
  }

  // ── Asheville — pickup 0 (no minimum), delivery 200 ────────────────────────
  const ash = await refFor('%atlanta bread%asheville%')
  console.log('\n=== Atlanta Bread — Asheville (expect pickup 0 / delivery $200) ===')
  if (!ash) { console.log('   FAIL  restaurant not found'); failures++ } else {
    const mins = await loadMenuOrderMinimums(ash.ref, ash.menu)
    console.log(`   ${ash.name} — pickup $${mins.pickup.toFixed(2)}, delivery $${mins.delivery.toFixed(2)}`)
    check('pickup minimum is 0', mins.pickup, 0)
    check('delivery minimum', mins.delivery, 200)
    // 0 must mean NO minimum, not "inherit delivery's 200".
    check('$0.01 pickup accepted', refused(mins, 'PICKUP', cartAt(0.01)), false)
    check('$5 pickup accepted', refused(mins, 'PICKUP', cartAt(5)), false)
    check('$199 pickup accepted', refused(mins, 'PICKUP', cartAt(199)), false)
    check('$199.99 delivery refused', refused(mins, 'DELIVERY', cartAt(199.99)), true)
    check('$200.00 delivery accepted', refused(mins, 'DELIVERY', cartAt(200)), false)
  }

  // ── Add-ons count toward the subtotal (client parity) ──────────────────────
  console.log('\n=== Add-ons count toward the minimum ===')
  if (bird) {
    const mins = await loadMenuOrderMinimums(bird.ref, bird.menu)
    // fmItemsToNativeCart folds add-on prices into `price`, so a $240 base + $10 of
    // add-ons is a $250 subtotal and must clear a $250 minimum.
    const folded: NativeCartItem[] = [{
      name: 'Base + add-ons', price: 250, basePrice: 240, quantity: 1,
      addOns: [{ name: 'Extra', price: 10, quantity: 1 }],
    }]
    check('$240 base + $10 add-on = $250 accepted', refused(mins, 'DELIVERY', folded), false)
    check('cartSubtotal folds to 250', cartSubtotal(folded), 250)
    const short: NativeCartItem[] = [{ name: 'Base only', price: 240, quantity: 1 }]
    check('$240 with no add-on refused', refused(mins, 'DELIVERY', short), true)
    // Multi-line cart summing over the minimum.
    check('$125 + $125 across two lines accepted',
      refused(mins, 'DELIVERY', [{ name: 'A', price: 125, quantity: 1 }, { name: 'B', price: 125, quantity: 1 }]), false)
    check('quantity counts: 5 x $50 accepted',
      refused(mins, 'DELIVERY', [{ name: 'A', price: 50, quantity: 5 }]), false)
  }

  // ── No valid order breaks ──────────────────────────────────────────────────
  console.log('\n=== No valid order breaks ===')
  const noMin = (await sql`
    SELECT c.name, c.restaurant_reference AS ref, m.reference AS menu,
           m.pickup_order_minimum::text AS p, m.delivery_order_minimum::text AS d
    FROM disco_menus m
    JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text AND c.is_disco_native
    WHERE NOT m.archived AND m.pickup_order_minimum = 0 AND m.delivery_order_minimum = 0
    LIMIT 3
  `) as unknown as { name: string; ref: string; menu: string; p: string; d: string }[]
  for (const r of noMin) {
    const mins = await loadMenuOrderMinimums(r.ref, r.menu)
    check(`${r.name}: no minimums → $1 pickup accepted`, refused(mins, 'PICKUP', cartAt(1)), false)
    check(`${r.name}: no minimums → $1 delivery accepted`, refused(mins, 'DELIVERY', cartAt(1)), false)
  }

  // Every configured menu must accept a cart AT its own minimum — the boundary
  // condition, swept across the whole estate so no single menu is off by a cent.
  console.log('\n=== Boundary sweep: every configured menu accepts exactly its minimum ===')
  const configured = (await sql`
    SELECT c.name, c.restaurant_reference AS ref, m.reference AS menu, m.name AS menu_name
    FROM disco_menus m
    JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text AND c.is_disco_native
    WHERE NOT m.archived AND (m.pickup_order_minimum > 0 OR m.delivery_order_minimum > 0)
    ORDER BY c.name, m.position
  `) as unknown as { name: string; ref: string; menu: string; menu_name: string }[]
  let swept = 0, boundaryFails = 0
  for (const r of configured) {
    const mins = await loadMenuOrderMinimums(r.ref, r.menu)
    for (const t of ['PICKUP', 'DELIVERY'] as const) {
      const m = t === 'DELIVERY' ? mins.delivery : mins.pickup
      if (m <= 0) {
        if (refused(mins, t, cartAt(0.01))) { boundaryFails++; console.log(`   FAIL  ${r.name} ${t}: minimum 0 but $0.01 refused`) }
        continue
      }
      if (refused(mins, t, cartAt(m))) { boundaryFails++; console.log(`   FAIL  ${r.name} ${t}: $${m} refused at its own minimum`) }
      if (!refused(mins, t, cartAt(Math.round((m - 0.01) * 100) / 100))) { boundaryFails++; console.log(`   FAIL  ${r.name} ${t}: $${m - 0.01} accepted below minimum`) }
      swept++
    }
  }
  failures += boundaryFails
  console.log(`   ${boundaryFails === 0 ? 'PASS' : 'FAIL'}  swept ${configured.length} menus / ${swept} configured thresholds — ${boundaryFails} boundary error(s)`)

  // ── Loader fallback behaviour ──────────────────────────────────────────────
  console.log('\n=== Loader fallbacks ===')
  if (bird) {
    const noMenuArg = await loadMenuOrderMinimums(bird.ref)
    check('no menuReference → primary-menu guess still resolves', noMenuArg.delivery, 250)
    const bogus = await loadMenuOrderMinimums(bird.ref, '00000000-0000-0000-0000-000000000000')
    check('unknown menuReference → falls back, does not throw', bogus.delivery, 250)
  }
  const bogusRest = await loadMenuOrderMinimums('00000000-0000-0000-0000-000000000000')
  check('unknown restaurant → 0/0 (no minimum), never a throw', bogusRest, { pickup: 0, delivery: 0 })

  console.log('\n' + '='.repeat(70))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
