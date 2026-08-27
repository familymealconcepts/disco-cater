/**
 * Verify the own-delivery fee read after routing computeOwnDeliveryFee and
 * menuRowToSettings through parseTier (the NaN checkout bug of 2026-08-27).
 *
 * Read-only. Exercises the REAL functions against the REAL stored delivery_settings
 * for each Atlanta Bread location, plus the two $30/15mi outliers, and asserts the
 * fee/total that the lost order should have produced.
 *
 *   npx tsx scripts/verify-own-delivery-fee-fix.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { computeOwnDeliveryFee, menuRowToSettings, type DeliverySettings } from '../lib/menu-settings'
import { cents, assertFiniteMoney } from '../lib/promo-pricing'
import { sql } from '../lib/db'

const r2 = (x: number) => Math.round(x * 100) / 100

// The cart that failed: Smyrna, 18 items, $204.70, 9% sales tax, no tip.
const LOST_ORDER = { subtotal: 204.70, taxPct: 9, expectedFee: 25.00, expectedTax: 18.42, expectedTotal: 248.12 }

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : ` — expected ${JSON.stringify(expected)}`}`)
}

async function main() {
  const rows = (await sql`
    SELECT c.name, m.reference, m.delivery_settings, m.offers_pickup, m.offers_delivery,
           m.service_charge_pct, m.service_charge_name, m.tip_default_type, m.tip_default_value,
           m.pickup_order_minimum, m.delivery_order_minimum, m.max_orders_per_day,
           m.lead_time_hours, m.rolling_availability_days, m.daily_cutoff_time, m.hard_cutoff_date
    FROM disco_menus m
    JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text
    WHERE NOT m.archived AND m.delivery_settings->>'method' = 'OWN_DELIVERY'
      AND (c.name ILIKE '%atlanta bread%' OR c.name IN ('The Winkin'' Rooster', '10th Ave. Burrito Co.'))
    ORDER BY c.name
  `) as Array<Record<string, any>>

  console.log(`Checking ${rows.length} own-delivery menus\n`)

  for (const row of rows) {
    const del = row.delivery_settings as DeliverySettings
    const raw = (del as any)?.own?.primary ?? {}
    const shape = ('feeFixed' in raw || 'feePercent' in raw) ? 'new' : 'legacy'
    // What FM/the row actually configures, read straight out of the blob so the
    // expectation is independent of the code under test.
    const configuredFee = Number(raw.feeValue ?? raw.feeFixed ?? 0)
    const configuredRadius = Number(raw.radiusMiles ?? 0)

    console.log(`${row.name}  [${shape} shape, $${configuredFee} / ${configuredRadius}mi]`)

    // 1) The checkout read — inside the radius.
    const inside = computeOwnDeliveryFee(del.own, Math.max(0, configuredRadius - 1), LOST_ORDER.subtotal)
    check('fee inside radius', inside.fee, configuredFee)
    check('serviceable inside radius', inside.serviceable, true)
    check('fee is finite', Number.isFinite(inside.fee), true)

    // 2) Serviceability must be unchanged by the fix — refuse past the OUTERMOST
    // configured ring. Winkin' Rooster is the only one of the 13 with a secondary
    // zone, so read the outer radius from the blob rather than assuming primary is it.
    const rawSec = (del as any)?.own?.secondary
    const outerRadius = Math.max(configuredRadius, Number(rawSec?.radiusMiles ?? 0))
    const outside = computeOwnDeliveryFee(del.own, outerRadius + 1, LOST_ORDER.subtotal)
    check('refused past outermost ring', outside.serviceable, false)
    if (rawSec) {
      const secFee = Number(rawSec.feeValue ?? rawSec.feeFixed ?? 0)
      const inSec = computeOwnDeliveryFee(del.own, outerRadius - 0.5, LOST_ORDER.subtotal)
      check(`secondary ring fee (${outerRadius}mi)`, inSec.fee, secFee)
    }

    // 3) The customer-page/settings read — the $0 display face of the same bug.
    // A configured 0 deliberately surfaces as null ("empty box", matching FM) rather
    // than 0, so only a NON-zero fee should read back as a number.
    const settings = menuRowToSettings(row as any)
    check('settings.ownDeliveryFee', settings.ownDeliveryFee, configuredFee > 0 ? configuredFee : null)
    check('settings.ownDeliveryRadius', settings.ownDeliveryRadius, configuredRadius)

    // 4) cents() accepts the amount a real charge would carry.
    const total = r2(LOST_ORDER.subtotal + r2(LOST_ORDER.subtotal * LOST_ORDER.taxPct / 100) + inside.fee)
    check('cents(total) is an integer', Number.isInteger(cents(total)), true)
    console.log('')
  }

  // ── The lost order, reconstructed exactly ──────────────────────────────────
  console.log('─'.repeat(72))
  console.log('Smyrna — reconstructing lost order 900000099-101 vs FM fallback 84648373\n')
  const smyrna = rows.find(r => r.name === 'Atlanta Bread - Smyrna')
  if (!smyrna) { console.log('   FAIL  Smyrna menu not found'); failures++ }
  else {
    const del = smyrna.delivery_settings as DeliverySettings
    const fee = computeOwnDeliveryFee(del.own, 0.4, LOST_ORDER.subtotal).fee   // real distance was ~0.4mi
    const tax = r2(LOST_ORDER.subtotal * LOST_ORDER.taxPct / 100)
    const total = r2(LOST_ORDER.subtotal + tax + fee)
    console.log(`   subtotal        ${LOST_ORDER.subtotal.toFixed(2)}`)
    console.log(`   sales tax @ 9%   ${tax.toFixed(2)}`)
    console.log(`   delivery fee     ${fee.toFixed(2)}`)
    console.log(`                   ──────`)
    console.log(`   total           ${total.toFixed(2)}\n`)
    check('delivery fee', fee, LOST_ORDER.expectedFee)
    check('sales tax', tax, LOST_ORDER.expectedTax)
    check('total matches FM order 84648373', total, LOST_ORDER.expectedTotal)
    check('Stripe amount', cents(total), 24812)
  }

  // ── The guards themselves must actually refuse ─────────────────────────────
  console.log('\n' + '─'.repeat(72))
  console.log('Guards\n')
  let threw = false
  try { cents(NaN) } catch { threw = true }
  check('cents(NaN) throws', threw, true)
  threw = false
  try { cents(Infinity) } catch { threw = true }
  check('cents(Infinity) throws', threw, true)
  check('cents(248.12) still works', cents(248.12), 24812)
  threw = false
  try { assertFiniteMoney({ total: NaN, subtotal: 204.7 }, 'test') } catch { threw = true }
  check('assertFiniteMoney refuses NaN', threw, true)
  threw = false
  try { assertFiniteMoney({ total: 248.12, deliveryFee: null, tip: undefined }, 'test') } catch { threw = true }
  check('assertFiniteMoney allows real values + null/undefined', threw, false)

  // ── Regression: a genuinely-unconfigured zone must still mean free, not NaN ──
  console.log('\n' + '─'.repeat(72))
  console.log('Regression — radius with no fee components is FREE delivery, not NaN\n')
  const freeZone = computeOwnDeliveryFee({ primary: { radiusMiles: 5 } as any }, 2, 100)
  check('serviceable', freeZone.serviceable, true)
  check('fee', freeZone.fee, 0)
  const pctOnly = computeOwnDeliveryFee({ primary: { radiusMiles: 5, feeType: 'PERCENT', feeValue: 10 } as any }, 2, 200)
  check('legacy percent-only zone → 10% of 200', pctOnly.fee, 20)
  const bothNew = computeOwnDeliveryFee({ primary: { radiusMiles: 5, feeFixed: 20, feePercent: 10 } as any }, 2, 200)
  check('new two-component zone → $20 + 10% of 200', bothNew.fee, 40)

  console.log('\n' + '='.repeat(72))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
