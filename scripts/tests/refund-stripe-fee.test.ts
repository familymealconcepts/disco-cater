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
check('reversals are bounded by what Stripe will reverse (the shared ledger)', () => ok(/RestaurantFunds\.read\(stripe, acct\)/.test(feeSrc) && /funds\.takeAnywhere\(own, needCents,/.test(feeSrc), 'collect uses RestaurantFunds'))
check('the fee is planned before the refund (planRefundRecovery)', () => ok(/export async function planRefundRecovery\(plan: RefundFundingPlan/.test(feeSrc), 'planner'))

// ── WHAT STRIPE WILL REVERSE (lib/order/reversal-funding.ts), offline against a stand-in Stripe ──
// Measured live 2 Nov 2026: a reversal is funded by the AVAILABLE balance or the reversed payout's
// OWN still-pending money — never by other orders' pending money (#900000748 vs #900000448).
async function ledgerChecks() {
const { RestaurantFunds, RefundFundingPlan } = await import('../../lib/order/reversal-funding')
type FakeTransfer = { id: string; amount: number; amount_reversed: number; destination: string; destination_payment: string; reversed?: boolean }
function fakeStripe(available: number, pending: number, pendingPayments: string[], transfers: FakeTransfer[]) {
  const future = Math.floor(Date.now() / 1000) + 86400, past = Math.floor(Date.now() / 1000) - 86400
  return {
    balance: { retrieve: async () => ({ available: [{ amount: available, currency: 'usd' }], pending: [{ amount: pending, currency: 'usd' }] }) },
    charges: { retrieve: async (id: string) => ({ balance_transaction: { available_on: pendingPayments.includes(id) ? future : past } }) },
    balanceTransactions: { retrieve: async () => ({ available_on: past }) },
    transfers: { list: async () => ({ data: transfers }) },
  } as never
}
const paidOut: FakeTransfer = { id: 'tr_paid', amount: 63505, amount_reversed: 0, destination: 'acct', destination_payment: 'py_paid' }
const other: FakeTransfer = { id: 'tr_other', amount: 10948, amount_reversed: 0, destination: 'acct', destination_payment: 'py_other' }
const stillPending: FakeTransfer = { id: 'tr_pend', amount: 12417, amount_reversed: 0, destination: 'acct', destination_payment: 'py_pend' }
{
  // #900000748: $0 available, $109.48 pending — all another order's. Its own $635.05 payout already paid out.
  const s748 = fakeStripe(0, 10948, ['py_other'], [paidOut, other])
  const f748 = await RestaurantFunds.read(s748, 'acct')
  eqCheck('#900000748: nothing can be reversed from the paid-out payout', await f748.room(paidOut as never), 0)
  const p748 = new RefundFundingPlan(s748)
  await p748.reverse(paidOut as never, 7091, 'edit payout reversal')
  check('#900000748: the $70.91 reversal is refused (the old available+pending rule passed it)', () => ok(!p748.ok && p748.unplacedCents === 7091 && 0 + 10948 >= 7091, `unplaced ${p748.unplacedCents}`))
  // #900000448: $0 available, the reversed payout's own money still pending.
  const s448 = fakeStripe(0, 196725, ['py_pend'], [stillPending])
  const p448 = new RefundFundingPlan(s448)
  await p448.reverse(stillPending as never, 2276, 'payout reversal')
  check('#900000448: $22.76 from the payout\'s own pending money is allowed', () => ok(p448.ok, `unplaced ${p448.unplacedCents}`))
  // The ledger carries across reversals: own pending can't be spent twice.
  const sTwice = fakeStripe(0, 12417, ['py_pend'], [stillPending])
  const pTwice = new RefundFundingPlan(sTwice)
  await pTwice.reverse(stillPending as never, 10000, 'first')
  await pTwice.reverse(stillPending as never, 3000, 'second')
  check('the ledger never plans more than a payout holds, across reversals', () => ok(!pTwice.ok && pTwice.unplacedCents === 583, `unplaced ${pTwice.unplacedCents}`))
  // Available balance funds any payout, up to what it has.
  const sAvail = fakeStripe(5000, 0, [], [paidOut])
  const pAvail = new RefundFundingPlan(sAvail)
  await pAvail.reverse(paidOut as never, 4000, 'payout reversal')
  await pAvail.owe('acct', paidOut as never, 1500, 'Stripe fee share')
  check('available balance funds a paid-out payout, and the fee share is refused past it', () => ok(!pAvail.ok && pAvail.neededCents === 5500 && pAvail.unplacedCents === 500, `needed ${pAvail.neededCents} unplaced ${pAvail.unplacedCents}`))
}
}
function eqCheck(name: string, a: unknown, b: unknown) { check(name, () => ok(JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)) }

ledgerChecks().then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}, (e) => { console.error(e); process.exit(1) })
