/**
 * Verifies the Stripe charge description RECONCILES to the charge, using the real
 * pricing engine — not hand-written figures.
 *
 * For each scenario it runs computeBreakdown, feeds the result to
 * buildNativeChargeDescription, then parses the money back OUT of the emitted string
 * and asserts the printed components sum to cents(total). Parsing the string back is
 * the point: it tests what a restaurant can actually add up, not what we intended.
 *
 *   npx tsx scripts/verify-charge-description.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { computeBreakdown, cents } from '../lib/promo-pricing'
import { buildNativeChargeDescription } from '../lib/order/charge-description'

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : ` — expected ${JSON.stringify(expected)}`}`)
}

const cfg = (over: Record<string, unknown> = {}) => ({
  scPct: 0,
  stateTax: { percent: 8.1, fixedAmount: 0 },
  localTax: { percent: 0, fixedAmount: 0 },
  otherTax: { applies: false, percent: 0, fixedAmount: 0 },
  familyMealPct: 3,
  stripePct: 2.9, stripeFlat: 0.3,
  leadGenPct: 0,
  ...over,
}) as Parameters<typeof computeBreakdown>[1]

/** Pull every "label N.NN" pair out of the emitted string and re-add them. */
function reconcileFromString(desc: string): { componentsCents: number; totalCents: number } {
  const seg = desc.split(' | ')
  let componentsCents = 0
  let totalCents = 0
  for (const part of seg) {
    const m = /^(Subtotal|Promo|Service charge|Sales tax|Delivery fee|Courier tip|Tip|Platform fee|Total) (-?)([\d.]+)/.exec(part)
    if (!m) continue
    const v = cents(Number(m[3])) * (m[2] === '-' ? -1 : 1)
    if (m[1] === 'Total') totalCents = Math.abs(v)
    else componentsCents += v
  }
  return { componentsCents, totalCents }
}

interface Scenario {
  name: string
  order: Parameters<typeof computeBreakdown>[0]
  discountPct: number
  cfgOver?: Record<string, unknown>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'the We Begg shape — 3P delivery, courier tip, tax',
    order: { subtotal: 180, ownDeliveryFee: 0, thirdPartyDeliveryFee: 27, thirdPartyDeliverySubsiding: 0, tipPct: 20, tipAmount: 0, tipCustom: false, tipsAreThirdParty: true },
    discountPct: 0,
  },
  { name: 'pickup, no delivery, no tip', order: { subtotal: 100, ownDeliveryFee: 0, thirdPartyDeliveryFee: 0, thirdPartyDeliverySubsiding: 0, tipPct: 0, tipAmount: 0, tipCustom: false, tipsAreThirdParty: false }, discountPct: 0 },
  { name: 'own-delivery $25 + restaurant tip 15%', order: { subtotal: 204.7, ownDeliveryFee: 25, thirdPartyDeliveryFee: 0, thirdPartyDeliverySubsiding: 0, tipPct: 15, tipAmount: 0, tipCustom: false, tipsAreThirdParty: false }, discountPct: 0 },
  { name: 'promo 10% + service charge 5%', order: { subtotal: 300, ownDeliveryFee: 0, thirdPartyDeliveryFee: 0, thirdPartyDeliverySubsiding: 0, tipPct: 0, tipAmount: 0, tipCustom: false, tipsAreThirdParty: false }, discountPct: 10, cfgOver: { scPct: 5 } },
  { name: 'custom dollar tip + local + other tax', order: { subtotal: 87.35, ownDeliveryFee: 12.5, thirdPartyDeliveryFee: 0, thirdPartyDeliverySubsiding: 0, tipPct: 0, tipAmount: 13.37, tipCustom: true, tipsAreThirdParty: false }, discountPct: 0, cfgOver: { localTax: { percent: 2.25, fixedAmount: 0 }, otherTax: { applies: true, percent: 0.5, fixedAmount: 0.15 } } },
  { name: 'awkward cents (rounding stress)', order: { subtotal: 33.33, ownDeliveryFee: 6.66, thirdPartyDeliveryFee: 0, thirdPartyDeliverySubsiding: 0, tipPct: 17.5, tipAmount: 0, tipCustom: false, tipsAreThirdParty: false }, discountPct: 7, cfgOver: { scPct: 3.75, stateTax: { percent: 6.375, fixedAmount: 0 } } },
]

const ITEMS = [
  { name: 'Fruit Cups', basePrice: 40, quantity: 1 },
  { name: '10 Sets of Utensils', basePrice: 5, quantity: 2 },
  { name: 'Breakfast Burritos', basePrice: 50, quantity: 1, addOns: [{ name: 'Add Bacon', price: 15, quantity: 1 }] },
]

async function main() {
  for (const sc of SCENARIOS) {
    const b = computeBreakdown(sc.order, cfg(sc.cfgOver), sc.discountPct)
    const desc = buildNativeChargeDescription({
      orderNumber: 900000999, orderDate: '2026-09-02',
      orderType: sc.order.thirdPartyDeliveryFee > 0 || sc.order.ownDeliveryFee > 0 ? 'DELIVERY' : 'PICKUP',
      items: ITEMS,
      subtotal: sc.order.subtotal,
      discount: b.discount, serviceCharge: b.serviceCharge,
      stateTax: b.stateTax, localTax: b.localTax, otherTax: b.otherTax,
      ownDeliveryFee: sc.order.ownDeliveryFee, thirdPartyDeliveryFee: sc.order.thirdPartyDeliveryFee,
      tipsInPrice: b.tipsInPrice, thirdPartyDeliveryTips: b.thirdPartyDeliveryTips,
      familyMealFee: b.familyMealFee, total: b.total,
    })
    console.log(`\n=== ${sc.name} ===`)
    if (!desc) { console.log('   FAIL  returned null (did not reconcile)'); failures++; continue }
    const { componentsCents, totalCents } = reconcileFromString(desc)
    check('printed components sum to the printed total', componentsCents, totalCents)
    check('printed total equals cents(breakdown.total)', totalCents, cents(b.total))
    console.log(`   ${desc}`)
  }

  // ── The specific FM errors must not be reproducible ────────────────────────
  console.log('\n=== the FM defects, as regressions ===')
  const b = computeBreakdown(SCENARIOS[0].order, cfg(), 0)
  const d = buildNativeChargeDescription({
    orderNumber: 1, orderDate: '2026-09-02', orderType: 'DELIVERY', items: ITEMS,
    subtotal: 180, discount: b.discount, serviceCharge: b.serviceCharge,
    stateTax: b.stateTax, localTax: b.localTax, otherTax: b.otherTax,
    ownDeliveryFee: 0, thirdPartyDeliveryFee: 27,
    tipsInPrice: b.tipsInPrice, thirdPartyDeliveryTips: b.thirdPartyDeliveryTips,
    familyMealFee: b.familyMealFee, total: b.total,
  })!
  check('tax is present', /Sales tax /.test(d), true)
  check('delivery fee is present', /Delivery fee /.test(d), true)
  check('courier tip is present and non-zero', /Courier tip (?!0\.00)/.test(d), true)
  check('a DELIVERY order is not labelled Pickup', /Pickup:/.test(d), false)
  check('unit price printed, not line total (Utensils 5.00 x2, never 10.00 x2)', /10 Sets of Utensils 5\.00 x2/.test(d), true)
  check('  ...and 10.00 x2 never appears', /Utensils 10\.00 x2/.test(d), false)

  // ── Non-reconciling input must refuse rather than print a wrong sum ────────
  console.log('\n=== a breakdown that does not add up returns null ===')
  const bad = buildNativeChargeDescription({
    orderNumber: 2, subtotal: 180, discount: 0, serviceCharge: 0,
    stateTax: 0, localTax: 0, otherTax: 0, ownDeliveryFee: 0, thirdPartyDeliveryFee: 0,
    tipsInPrice: 0, thirdPartyDeliveryTips: 0, familyMealFee: 5.4,
    total: 262.98, // the FM bug, exactly: components 185.40 vs a 262.98 total
  })
  check('refuses the FM mismatch', bad, null)

  console.log('\n' + '='.repeat(64))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
