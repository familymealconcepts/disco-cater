// Regression/verification for TASK 3 — max_orders_per_day enforcement.
//
// Exercises the REAL native checkout entry point (placeNativeCheckout →
// buildNativePlaceInput → isNativeDailyCapReached), not a reimplementation of
// the check, against a temp disco-native test restaurant + a real (test-mode)
// Stripe client. Confirms:
//   1. A restaurant with max_orders_per_day = 2 accepts 2 orders then blocks
//      the 3rd with a clear customer-facing message (409).
//   2. The cap is scoped per calendar day — a 3rd order on a DIFFERENT date
//      is still accepted.
//   3. A CANCELLED order no longer counts toward the cap (blocking is based
//      on still-active orders, not row count).
//   4. A restaurant with max_orders_per_day left unset (NULL, the default)
//      can place unlimited orders — current/prior behavior, now intentional.
//
// Read/writes only its own temp rows (unique refs), cleans up after itself.
// Run from the disco-cater folder:  node_modules/.bin/tsx scripts/test-max-orders-cap.ts

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
import { sql, runMigrations, runDiscoOrderMigrations, runDiscoMenuMigrations } from '../lib/db'
import { placeNativeCheckout } from '../lib/order/native-place-checkout'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${e}`)) }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])

function isoDate(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

async function placeOne(ref: string, email: string, orderDate: string) {
  return placeNativeCheckout({
    restaurantReference: ref,
    customerEmail: email,
    checkoutDetails: {
      orderDate,
      orderTime: '12:00',
      orderType: 'PICKUP',
      tips: 0,
      tipsType: 'PERCENTAGE',
      items: [{ name: 'Test Item', price: 10, count: 1 }],
    },
    stripe,
  })
}

async function main() {
  await runMigrations()
  await runDiscoMenuMigrations().catch(() => {})
  await runDiscoOrderMigrations().catch(() => {})

  const cappedRef = randomUUID()
  const uncappedRef = randomUUID()
  const email = `cap-test+${Date.now()}@disco-test.invalid`
  const today = isoDate(0)
  const tomorrow = isoDate(1)

  try {
    await sql`INSERT INTO disco_restaurant_cache (restaurant_reference, name, slug, is_disco_native, is_live) VALUES
      (${cappedRef}, 'Cap Test Restaurant', ${'cap-test-' + Date.now()}, true, true),
      (${uncappedRef}, 'Uncapped Test Restaurant', ${'uncap-test-' + Date.now()}, true, true)`

    await sql`INSERT INTO disco_menus (restaurant_reference, name, visible, archived, max_orders_per_day)
      VALUES (${cappedRef}, 'Catering Menu', true, false, 2)`
    await sql`INSERT INTO disco_menus (restaurant_reference, name, visible, archived, max_orders_per_day)
      VALUES (${uncappedRef}, 'Catering Menu', true, false, NULL)`

    console.log('1) Capped restaurant (max_orders_per_day = 2), same date:')
    const r1 = await placeOne(cappedRef, email, today)
    ok('order 1 accepted', r1.ok === true, r1.ok ? '' : `→ ${JSON.stringify(r1)}`)
    const r2 = await placeOne(cappedRef, email, today)
    ok('order 2 accepted', r2.ok === true, r2.ok ? '' : `→ ${JSON.stringify(r2)}`)
    const r3 = await placeOne(cappedRef, email, today)
    ok('order 3 BLOCKED', r3.ok === false, r3.ok ? '→ was accepted, should have been blocked' : '')
    if (!r3.ok) {
      ok('order 3 has a clear customer-facing message', /maximum number of orders/i.test(r3.error), `→ "${r3.error}"`)
      ok('order 3 status is 409 (not a generic 500/403)', r3.status === 409, `→ ${r3.status}`)
    }

    console.log('\n2) Cap is scoped per calendar day (different date, same restaurant):')
    const r4 = await placeOne(cappedRef, email, tomorrow)
    ok('order accepted on a different date despite today being at cap', r4.ok === true, r4.ok ? '' : `→ ${JSON.stringify(r4)}`)

    console.log('\n3) Cancelling one of today\'s orders frees a slot:')
    if (r1.ok) await sql`UPDATE disco_orders SET order_status = 'CANCELLED' WHERE reference = ${r1.result.orderReference}::uuid`
    const r5 = await placeOne(cappedRef, email, today)
    ok('order accepted after a CANCELLED order stopped counting toward the cap', r5.ok === true, r5.ok ? '' : `→ ${JSON.stringify(r5)}`)
    const r6 = await placeOne(cappedRef, email, today)
    ok('cap re-enforced once back at 2 active orders for the day', r6.ok === false, r6.ok ? '→ was accepted, should have been blocked' : '')

    console.log('\n4) Uncapped restaurant (max_orders_per_day left NULL) — unlimited orders, same day:')
    let allUncappedOk = true
    for (let i = 0; i < 5; i++) {
      const r = await placeOne(uncappedRef, email, today)
      if (!r.ok) { allUncappedOk = false; console.log(`   order ${i + 1} unexpectedly blocked: ${JSON.stringify(r)}`) }
    }
    ok('5 orders in a row all accepted (no cap set = no cap enforced)', allUncappedOk)

    const countRows = (await sql`SELECT COUNT(*)::int AS n FROM disco_orders WHERE restaurant_reference = ${uncappedRef}::uuid`) as { n: number }[]
    ok('5 real order rows actually exist for the uncapped restaurant', countRows[0]?.n === 5, `→ ${countRows[0]?.n}`)
  } finally {
    await sql`DELETE FROM disco_stripe_payments WHERE restaurant_reference IN (${cappedRef}, ${uncappedRef})`.catch(() => {})
    await sql`DELETE FROM disco_sale_transactions WHERE order_id IN (SELECT id FROM disco_orders WHERE restaurant_reference IN (${cappedRef}, ${uncappedRef}))`.catch(() => {})
    await sql`DELETE FROM disco_order_items WHERE order_id IN (SELECT id FROM disco_orders WHERE restaurant_reference IN (${cappedRef}, ${uncappedRef}))`.catch(() => {})
    await sql`DELETE FROM disco_orders WHERE restaurant_reference IN (${cappedRef}, ${uncappedRef})`.catch(() => {})
    await sql`DELETE FROM disco_menus WHERE restaurant_reference IN (${cappedRef}, ${uncappedRef})`.catch(() => {})
    await sql`DELETE FROM disco_restaurant_cache WHERE restaurant_reference IN (${cappedRef}, ${uncappedRef})`.catch(() => {})
  }
  console.log(`\n──────────\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
