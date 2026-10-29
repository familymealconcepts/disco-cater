// Guards for Peter's 2026-10-29 reporting decisions: payment labels (1), Stripe's actual fee and
// the true-up (3), and Stripe's actual payout on the sheet (4).
// Run: npx tsx scripts/tests/stripe-facts.test.ts
import { readFileSync } from 'node:fs'
import { paymentLabel, PAID_LABELS } from '../../lib/order/stripe-facts'
import { trueupDelta, trueupEnabled } from '../../lib/order/stripe-fee-trueup'
import { capShortfallCents } from '../../lib/order/refund-stripe-fee'
import { reconcileRow, totalsRow, TOTALS_LABEL, ORDER_REPORT_COLUMNS, type OrderReportRow } from '../../lib/reports/order-report-rows'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg) }
const read = (p: string) => readFileSync(p, 'utf8')

const base = { orderStatus: 'DUE', captured: null, refunded: null, invoiceStatus: null, paidInDisco: false, refundInDisco: 0, totalInDisco: 100 }
console.log('\n=== payment labels (decision 1) ===')
check('Stripe facts: paid, partial, refunded', () => {
  eq(paymentLabel({ ...base, captured: 10000, refunded: 0 }), 'Paid', 'paid')
  eq(paymentLabel({ ...base, captured: 10000, refunded: 2500 }), 'Partially refunded', 'partial')
  eq(paymentLabel({ ...base, captured: 10000, refunded: 10000 }), 'Refunded', 'full')
})
check('a refund made in the Stripe dashboard counts (#900000288)', () =>
  eq(paymentLabel({ ...base, orderStatus: 'COMPLETED', captured: 33634, refunded: 16817 }), 'Partially refunded', 'label'))
check('unpaid kinds', () => {
  eq(paymentLabel({ ...base, orderStatus: 'UNPAID', captured: 0, refunded: 0, invoiceStatus: 'open' }), 'Unpaid invoice', 'open invoice')
  eq(paymentLabel({ ...base, orderStatus: 'COMPLETED', captured: 0, refunded: 0, invoiceStatus: 'void' }), 'Voided', 'void (#900000298)')
  eq(paymentLabel({ ...base, orderStatus: 'RESERVED', captured: 0, refunded: 0 }), 'Abandoned checkout', 'reserved')
  eq(paymentLabel({ ...base, orderStatus: 'EXPIRED', captured: 0, refunded: 0 }), 'Abandoned checkout', 'expired')
  eq(paymentLabel({ ...base, orderStatus: 'PAYMENT_FAILED', captured: 0, refunded: 0 }), 'Declined', 'declined')
})
check('a paid invoice with nothing captured ($0 / outside Stripe) is Paid', () =>
  eq(paymentLabel({ ...base, orderStatus: 'COMPLETED', captured: 0, refunded: 0, invoiceStatus: 'paid' }), 'Paid', 'label'))
check('before the first sync, Disco\'s own record decides', () => {
  eq(paymentLabel({ ...base, paidInDisco: true }), 'Paid', 'paid')
  eq(paymentLabel({ ...base, paidInDisco: true, refundInDisco: 100 }), 'Refunded', 'refunded')
  eq(paymentLabel({ ...base, orderStatus: 'UNPAID' }), 'Unpaid invoice', 'unpaid')
})
check('only the three paid labels count as paid', () => eq([...PAID_LABELS].sort(), ['Paid', 'Partially refunded', 'Refunded'], 'set'))

console.log('\n=== true-up (decision 3) ===')
check('the whole difference on an unrefunded charge (#900000456: $14.20 est, $21.38 actual)', () => eq(trueupDelta(2138, 1420, 47917, 0), 718, 'delta'))
check('a fee below the estimate pays the restaurant', () => eq(trueupDelta(500, 1420, 47917, 0), -920, 'delta'))
check('only the kept share once part is refunded', () => eq(trueupDelta(2138, 1420, 40000, 10000), 539, 'delta'))
check('nothing on a fully refunded charge', () => eq(trueupDelta(2138, 1420, 40000, 40000), 0, 'delta'))
check('off unless both switches are set', () => {
  const save = { ...process.env }
  delete process.env.STRIPE_FEE_TRUEUP_ENABLED; process.env.STRIPE_FEE_TRUEUP_SINCE = '2026-11-01T00:00:00Z'
  eq(trueupEnabled().on, false, 'no flag')
  process.env.STRIPE_FEE_TRUEUP_ENABLED = '1'; delete process.env.STRIPE_FEE_TRUEUP_SINCE
  eq(trueupEnabled().on, false, 'no cutover')
  process.env.STRIPE_FEE_TRUEUP_SINCE = '2026-11-01T00:00:00Z'
  eq(trueupEnabled().on, true, 'both')
  process.env = save
})
check('capped reversal shortfall (measured in test mode: $52.08 due, $50.80 reversed)', () => {
  eq(capShortfallCents(8680, 6000, 10000, 5080), 128, 'shortfall')
  eq(capShortfallCents(8680, 6000, 10000, 5207), 0, 'a cent of rounding is not a cap')
})

console.log('\n=== the sheet (decision 4) ===')
const row = (o: Partial<OrderReportRow>): OrderReportRow => ({
  location: 'X', orderId: '1', customerName: '', createdDate: '', serviceType: 'Pickup', orderDate: '', orderTime: '',
  netSales: 100, stateTax: 0, localTax: 0, otherTax: 0, selfDeliveryFee: 0, thirdPartyDeliveryFee: 0,
  tipPickup: 0, tipSelfDelivery: 0, tipThirdPartyDelivery: 0, tipThirdPartyCourierPortion: 0, serviceCharge: 0, discount: 0,
  leadGenOne: 10, leadGenTwo: 0, gross: 100, stripeFee: 3.2, refundAmount: 0, thirdPartySubsidy: 0, refundStripeFee: 0,
  payoutAdjustment: 0, totalDistributed: 86.8, paymentStatus: 'Paid', paid: true, refundReversal: 0, settlement: 'native',
  orderStatus: 'DUE', deliveryType: null, ...o,
} as OrderReportRow)
check('a payout that differs from the figures reconciles through the adjustment', () => {
  ok(reconcileRow(row({ totalDistributed: 90.0, payoutAdjustment: 3.2 })).ok, 'with adjustment')
  ok(!reconcileRow(row({ totalDistributed: 90.0, payoutAdjustment: 0 })).ok, 'control: without it fails')
})
check('an unpaid row has no payout and reconciles only at zero', () => {
  ok(reconcileRow(row({ paid: false, paymentStatus: 'Unpaid invoice', totalDistributed: 0 })).ok, 'zero')
  ok(!reconcileRow(row({ paid: false, paymentStatus: 'Unpaid invoice', totalDistributed: 86.8 })).ok, 'control: a payout fails')
})
check('the totals row sums paid orders only', () => {
  const t = totalsRow([row({}), row({ paid: false, paymentStatus: 'Abandoned checkout', totalDistributed: 0, netSales: 500, gross: 500 })])
  eq([t.netSales, t.gross, t.totalDistributed], [100, 100, 86.8], 'totals')
  ok(/paid/i.test(TOTALS_LABEL), 'label says so')
})
check('Payment and Payout Adjustment are columns; adjustment sits before Total Distributed', () => {
  const keys = ORDER_REPORT_COLUMNS.map(c => c.key)
  ok(keys.indexOf('paymentStatus') === keys.indexOf('orderStatus') + 1, 'payment after status')
  ok(keys.indexOf('payoutAdjustment') === keys.indexOf('totalDistributed') - 1, 'adjustment before payout')
})

console.log('\n=== source guards ===')
const rep = read('lib/reports/order-report-rows.ts')
check('Stripe facts are joined for Disco-processed orders only', () => ok(/disco_order_stripe_facts sf ON sf\.order_reference = o\.reference::text AND o\.fm_order_reference IS NULL/.test(rep), 'join'))
check('FamilyMeal-copied rows keep FM\'s formula and get no label', () => {
  ok(rep.includes(': !isNative ? fmTotalDistributed(row, refund)'), 'fm formula')
  ok(rep.includes("const paymentStatus = disco ? paymentLabel({"), 'label gated')
})
const facts = read('lib/order/stripe-facts.ts')
check('the facts sync never reads FamilyMeal-copied orders', () => {
  ok(/WHERE o\.reference = \$\{orderReference\}::uuid AND o\.fm_order_reference IS NULL/.test(facts), 'collect')
  eq((facts.match(/WHERE o\.fm_order_reference IS NULL AND \(/g) ?? []).length, 2, 'payment-intent and invoice lookups')
})
check('refreshed by the webhook after each event is handled, never on a schedule', () => {
  const wh = read('app/api/stripe/webhook/route.ts')
  const at = wh.indexOf('waitUntil(refreshStripeFactsForEvent(stripe, event))')
  ok(at > wh.indexOf("console.log('[Webhook] Unhandled event:'"), 'after the switch')
  ok(!read('vercel.json').includes('stripe-facts') && !read('vercel.json').includes('stripe-fee-trueup'), 'no cron')
})
check('every event that moves an order\'s money refreshes it', () => {
  for (const e of ['payment_intent.succeeded', 'charge.refunded', 'charge.updated', 'invoice.paid', 'invoice.payment_succeeded', 'transfer.reversed'])
    ok(facts.includes(`'${e}'`), e)
})
check('refund-fee recoveries are not counted twice in the payout', () => ok(facts.includes("r.metadata?.kind !== REFUND_FEE_KIND"), 'excluded from facts'))
const tu = read('lib/order/stripe-fee-trueup.ts')
check('true-up claims before it moves money, and is idempotent on the charge', () => {
  ok(tu.indexOf("record(c, chargeId, 'pending'") < tu.indexOf('await settleFeeDifference(stripe'), 'claim first')
  ok((tu.match(/idempotencyKey: `fee-trueup:\$\{i\.chargeId\}`/g) ?? []).length === 2, 'both moves keyed')
})
check('true-up only for charges after the cutover, 10+ minutes old, Disco-processed', () => {
  ok(tu.includes('sp.created_at >= ${since.toISOString()}::timestamptz') && tu.includes("INTERVAL '10 minutes'") && tu.includes('o.fm_order_reference IS NULL'), 'filters')
})
check('checkout and charge creation are untouched by the true-up', () => ok(!/paymentIntents\.create|invoices\.create/.test(tu), 'no charge creation'))

console.log(failures.length ? `\nFAILED ${failures.length}: ${failures.join(', ')}` : `\nALL PASS ${passed} passed`)
if (failures.length) process.exit(1)
