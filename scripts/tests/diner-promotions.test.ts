// Guards for diner promotions — "Free delivery on your next order from [restaurant]" (Peter, 2026-11-18).
// Run: npx tsx scripts/tests/diner-promotions.test.ts
// The database half runs against a local Postgres: scripts/tests/diner-promotions-db.test.ts.
//
//   1. The restaurant's payout is exactly what it would have been with the fee charged; the diner's
//      total drops by the fee; tax, tip, service charge and fees are unchanged.
//   2. Status: unused and past its expiry reads Expired; default expiry is 60 days, Eastern.
//   3. The email: subject, Activate link, expiry.
//   4. Wiring: diner checkout only (never direct entry), taken before any charge and given back on
//      failure, released on cancel/void/abandon/switch, third-party delivery only, reports.
import { readFileSync } from 'node:fs'
import { computeBreakdown, type PricingConfig, type PricingOrder } from '../../lib/promo-pricing'
import { effectiveStatus, defaultExpiresOn, todayEastern, freeDeliveryEmail } from '../../lib/promotions/diner-promotions'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const src = (f: string) => readFileSync(f, 'utf8')

const cfg: PricingConfig = {
  scPct: 4, stateTax: { percent: 8.875, fixedAmount: 0 }, localTax: { percent: 0, fixedAmount: 0 },
  otherTax: { percent: 0, fixedAmount: 0, applies: false }, familyMealPct: 3, stripePct: 2.9, stripeFlat: 0.3, leadGenPct: 15,
}
const order = (o: Partial<PricingOrder> = {}): PricingOrder => ({
  subtotal: 313.47, ownDeliveryFee: 0, thirdPartyDeliveryFee: 47.02, thirdPartyDeliverySubsiding: 0,
  tipCustom: true, tipAmount: 31.35, tipPct: 0, tipsAreThirdParty: true, ...o,
})

console.log('\n=== Diner promotions: free delivery ===')
check("the restaurant's payout is unchanged; the diner pays the fee less", () => {
  const full = computeBreakdown(order(), cfg, 0)
  const free = computeBreakdown(order({ thirdPartyDeliveryFee: 0, discoWaivedDeliveryFee: 47.02 }), cfg, 0)
  eq(free.transfer, full.transfer, 'transfer')
  eq(free.stripeFee, full.stripeFee, "restaurant's card-fee share")
  eq(Math.round((full.total - free.total) * 100) / 100, 47.02, 'total drops by the fee')
  for (const k of ['stateTax', 'localTax', 'otherTax', 'serviceCharge', 'familyMealFee', 'thirdPartyDeliveryTips', 'leadGen', 'discount'] as const) eq(free[k], full[k], k)
})
check("with a restaurant's own delivery subsidy, it still pays its share", () => {
  const full = computeBreakdown(order({ thirdPartyDeliveryFee: 31.35, thirdPartyDeliverySubsiding: 15.67 }), cfg, 10)
  const free = computeBreakdown(order({ thirdPartyDeliveryFee: 0, thirdPartyDeliverySubsiding: 15.67, discoWaivedDeliveryFee: 31.35 }), cfg, 10)
  eq(free.transfer, full.transfer, 'transfer, with a promo code discount too')
})
check('no promotion: pricing is exactly as before', () => {
  const a = computeBreakdown(order(), cfg, 0)
  const b = computeBreakdown(order({ discoWaivedDeliveryFee: 0 }), cfg, 0)
  eq(a, b, 'identical')
})
check('status and expiry', () => {
  const past = new Date(Date.now() - 60_000), future = new Date(Date.now() + 60_000)
  eq([effectiveStatus('OFFERED', past), effectiveStatus('ACTIVATED', past), effectiveStatus('USED', past), effectiveStatus('CANCELLED', past)],
    ['EXPIRED', 'EXPIRED', 'USED', 'CANCELLED'], 'past expiry')
  eq(effectiveStatus('ACTIVATED', future), 'ACTIVATED', 'before expiry')
  eq(defaultExpiresOn(new Date('2026-11-18T15:00:00Z')), '2027-01-17', '60 days')
  eq(todayEastern(new Date('2026-11-19T03:30:00Z')), '2026-11-18', 'Eastern, not UTC')
})
check('the email', () => {
  const e = freeDeliveryEmail({ reference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restaurantName: 'Apollo Bagels - Tribeca', restaurantSlug: 'apollobagels-tribeca', expiresOn: '2027-01-17' }, 'Dana')
  eq(e.subject, "You've got free delivery on your next order from Apollo Bagels - Tribeca", 'subject')
  for (const s of ['https://www.discocater.com/account/promotions?activate=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Activate free delivery', 'January 17, 2027', 'Hi Dana,', '/restaurants/apollobagels-tribeca'])
    if (!e.html.includes(s)) throw new Error(`missing ${s}`)
})
check('third-party delivery only, priced once for preview and placement', () => {
  const c = src('lib/order/native-checkout.ts')
  if (!c.includes("if (input.freeDelivery === true && fulfillment === 'THIRD_PARTY_DELIVERY' && deliveryValid && deliveryFee > 0) {")) throw new Error('gate')
  if (!c.includes('${b.discount}, ${discoWaivedDeliveryFee},')) throw new Error('not recorded on the sale transaction')
  const pc = src('lib/order/native-place-checkout.ts')
  if (!pc.includes("const freeDeliveryPromotion = params.dinerPromotionEmail && params.isDirectEntry !== true")) throw new Error('placement lookup')
  if (!pc.includes('priced.discoWaivedDeliveryFee > 0 && freeDeliveryPromotion ? freeDeliveryPromotion.id : null')) throw new Error('only taken when it waived a fee')
})
check("diner checkout only: the diner's route passes the session email, direct entry never does", () => {
  if (!src('app/api/order/place/route.ts').includes('dinerPromotionEmail: session.email,')) throw new Error('diner route')
  if (src('app/api/restaurant/orders/place/route.ts').includes('dinerPromotionEmail')) throw new Error('direct entry must not')
  if (!src('lib/promotions/checkout-preview.ts').includes("if (body?.discoDirectEntry === true || !restaurantRef) return false")) throw new Error('preview')
  if (!src('app/(customer)/restaurants/[slug]/CheckoutDrawer.tsx').includes('...(isDirectEntry ? { discoDirectEntry: true } : {}),')) throw new Error('drawer marker')
})
check('taken before any charge, given back if placement fails', () => {
  const pc = src('lib/order/native-place-checkout.ts')
  const take = pc.indexOf('!(await reserveForOrder(freeDeliveryPromotionId))')
  const charge = pc.indexOf('result = await placeAndPayNativeOrder(input, params.stripe, params.savedOpts)')
  if (take < 0 || charge < 0 || take > charge) throw new Error('order')
  if (!pc.includes('if (freeDeliveryPromotionId != null) await releaseReservation(freeDeliveryPromotionId)')) throw new Error('release on failure')
})
check('back to Activated: cancel or void before delivery, abandoned checkout, switched off courier delivery', () => {
  if (!src('lib/order/native-status-change.ts').includes('await releaseForCancelledOrder(rows[0].reference, source)')) throw new Error('cancel')
  if (!src('app/api/restaurant/orders/[ref]/void/route.ts').includes("await releaseForCancelledOrder(reference, 'DISCO_VOID')")) throw new Error('void')
  if (!src('lib/order/native-reserved-expiry.ts').includes("await releaseForOrder(row.reference, 'checkout never paid', 'RESERVED_EXPIRY_SWEEP')")) throw new Error('abandoned')
  const edit = src('app/api/restaurant/orders/[ref]/edit/route.ts')
  if (!edit.includes("await releaseForOrder(discoOrder.reference, 'switched off third-party delivery', 'PORTAL_EDIT')")) throw new Error('switch')
  if (!edit.includes("discoWaivedDeliveryFee: fulfillment === 'THIRD_PARTY_DELIVERY' ? await waivedForOrder(discoOrder.reference) : 0,")) throw new Error('edits keep the payout')
})
check('reports: Super Admin shows it as Disco-funded; restaurant reports unchanged', () => {
  if (!src('app/api/admin/dashboard/sale-stats/route.ts').includes('"discoPromoDeliveryWaivedSum"')) throw new Error('admin dashboard')
  if (!src('app/(admin)/admin/(protected)/manage-orders/page.tsx').includes("detailRow('Free delivery (Disco promotion)'")) throw new Error('admin order')
  for (const f of ['lib/reports/order-report-rows.ts', 'app/api/restaurant/dashboard/sale-stats/route.ts']) if (src(f).includes('disco_promo_delivery_waived')) throw new Error(`${f} must not change`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
