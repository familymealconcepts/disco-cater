// Guards for the Stripe fee the restaurant bears on a refund (lib/order/refund-stripe-fee.ts).
// Run: npx tsx scripts/tests/refund-stripe-fee.test.ts
//
//   1. refundFeeShare: proportional, cumulative across partials (never drifts by a cent), capped at the fee.
//   2. Source guards: every refund path calls the recovery AFTER the customer's refund, and recovery never throws.
import { readFileSync } from 'node:fs'
import { refundFeeShare } from '../../lib/order/refund-stripe-fee'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg) }
const read = (p: string) => readFileSync(p, 'utf8')

console.log('\n=== refundFeeShare ===')
check('full refund takes the whole fee', () => eq(refundFeeShare(1097, 36805, 0, 36805), 1097, 'full'))
check('half refund takes half', () => eq(refundFeeShare(320, 10000, 0, 5000), 160, 'half'))
check('partials sum to the whole fee exactly', () => {
  const parts = [3333, 3333, 3334]
  let before = 0, sum = 0
  for (const p of parts) { sum += refundFeeShare(1001, 10000, before, p); before += p }
  eq(sum, 1001, 'sum of thirds')
})
check('never past the captured amount', () => eq(refundFeeShare(320, 10000, 9000, 5000), 32, 'capped'))
check('nothing for zero or negative inputs', () => {
  eq([refundFeeShare(0, 10000, 0, 100), refundFeeShare(320, 0, 0, 100), refundFeeShare(320, 10000, 0, 0)], [0, 0, 0], 'zeros')
})

console.log('\n=== source guards ===')
const refundSrc = read('lib/order/native-refund.ts')
check('all three refund paths recover the fee', () => eq((refundSrc.match(/await recoverRefundStripeFee\(/g) ?? []).length, 3, 'call count'))
check('card path recovers after stripe.refunds.create', () => {
  const body = refundSrc.slice(refundSrc.indexOf('export async function refundNativeOrder'))
  ok(body.indexOf('stripe.refunds.create') < body.indexOf('recoverRefundStripeFee('), 'order')
})
check('invoice path recovers after the credit note', () => ok(refundSrc.indexOf('stripe.creditNotes.create') < refundSrc.indexOf('await recoverRefundStripeFee({\n      stripe, orderReference, chargeId: invChargeBefore.id'), 'order'))
const feeSrc = read('lib/order/refund-stripe-fee.ts')
check('recoverRefundStripeFee is wrapped in a catch-all', () => {
  const body = feeSrc.slice(feeSrc.indexOf('export async function recoverRefundStripeFee'))
  ok(/^\s*try \{/m.test(body.split('\n')[1]), 'try first')
  ok(body.includes('the customer refund stands'), 'non-fatal catch')
})
check('the refund is claimed before any reversal (idempotent retry)', () => ok(feeSrc.indexOf('ON CONFLICT (stripe_refund_id) DO NOTHING') < feeSrc.indexOf('try { sources = await collect('), 'claim first'))
check('reversals are bounded by the balance', () => ok(/Math\.min\(left, need, room\)/.test(feeSrc), 'bounded'))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
