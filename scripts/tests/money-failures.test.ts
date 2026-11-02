// Guards for refund money failures recorded for NM OS's ops watch (lib/order/money-failures.ts, table
// 009_disco_money_failures.sql). Run: npx tsx scripts/tests/money-failures.test.ts
//
//   1. Stripe's error is stored as its message, at most 300 characters.
//   2. Source guards: each of the six refund alerts in native-refund.ts is preceded by a
//      recordMoneyFailure of the right kind, every refundNativeOrder caller says which it is, and the
//      table's CHECKs match what the code writes. Each control-tested against a doctored copy.
import { readFileSync } from 'node:fs'
import { storedError } from '../../lib/order/money-failures'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg) }
const read = (p: string) => readFileSync(p, 'utf8')

console.log('\n=== stored error ===')
check('an Error is stored as its message', () => eq(storedError(new Error('insufficient funds')), 'insufficient funds', 'message'))
check('at most 300 characters', () => eq(storedError('x'.repeat(400))?.length, 300, 'length'))
check('nothing stays nothing', () => { eq(storedError(null), null, 'null'); eq(storedError(''), null, 'empty') })

console.log('\n=== source guards ===')
const SRC = read('lib/order/native-refund.ts')
// Every alert is preceded (within the same block) by a record of the matching kind.
const pairs: Array<[string, string, number]> = [
  ['alertRefundRefused(', "kind: 'refund_refused'", 1],
  ['alertRefundFromDiscoFunds(', "kind: 'refund_from_disco_funds'", 1],
  ['alertRestaurantKeptPayout(', "kind: 'payout_not_reversed'", 3],
]
function recordedBeforeEachAlert(s: string): string | null {
  for (const [alert, kind, expected] of pairs) {
    const calls = s.split(`await ${alert}`).length - 1
    if (calls !== expected) return `${alert} called ${calls} times, expected ${expected}`
    let from = 0
    for (let i = 0; i < calls; i++) {
      const at = s.indexOf(`await ${alert}`, from)
      const before = s.slice(Math.max(0, at - 400), at)
      if (!before.includes('recordMoneyFailure(') || !before.includes(kind)) return `${alert} #${i + 1} is not preceded by ${kind}`
      from = at + 1
    }
  }
  return null
}
check('each of the six refund alerts is recorded first, with the matching kind', () => { const why = recordedBeforeEachAlert(SRC); ok(!why, why ?? '') })
check('  control: dropping one record fails', () => {
  const doctored = SRC.replace("kind: 'payout_not_reversed', via, orderReference, refundAmount: amountDollars,", "via, orderReference, refundAmount: amountDollars,")
  ok(doctored !== SRC && recordedBeforeEachAlert(doctored), 'vacuous')
})
// Every refund path checks the restaurant can give its share back (assertRestaurantFundsRefund):
// the invoice path twice, the slices, the edit's exact reversal and a FamilyMeal-processed payment.
const FUNDING_CHECK = /assertRestaurantFundsRefund\(plan, \{ orderReference, refundCents: [^,]+, via[,\s}]/g
check('via reaches all five funding checks and the invoice path', () => {
  eq((SRC.match(FUNDING_CHECK) ?? []).length, 5, 'assertRestaurantFundsRefund calls carrying via')
  ok(/refundNativeInvoiceOrder\(stripe, orderReference, amountDollars, via\)/.test(SRC), 'invoice path gets via')
})
check('  control: a funding check without via fails', () => {
  const doctored = SRC.replace('assertRestaurantFundsRefund(plan, { orderReference, refundCents: want, via, paymentIntentId })', 'assertRestaurantFundsRefund(plan, { orderReference, refundCents: want, paymentIntentId } as never)')
  ok(doctored !== SRC && (doctored.match(FUNDING_CHECK) ?? []).length === 4, 'vacuous')
})

// EVERY REFUND COMES FROM THE RESTAURANT (Peter, 2 Nov 2026). A Stripe refund or credit note issued
// anywhere but lib/order/native-refund.ts skips the funding check — that is how the FamilyMeal-edit
// refund and the Disco-funded promo refund paid customers out of Disco's balance. The admin test
// runner is the one exception: it runs against Stripe TEST mode only.
console.log('\n=== every refund comes from the restaurant ===')
import { readdirSync, statSync } from 'node:fs'
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = `${dir}/${n}`; return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : /\.(ts|tsx)$/.test(n) ? [p] : [] })
}
const REFUND_CALL = /\.(refunds\.create|creditNotes\.create)\(/
const ALLOWED = new Set(['lib/order/native-refund.ts', 'app/api/admin/tests/run/route.ts'])
function strayRefunds(files: Array<[string, string]>): string[] {
  return files.filter(([p, s]) => !ALLOWED.has(p) && REFUND_CALL.test(s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))).map(([p]) => p)
}
const ALL = [...walk('app'), ...walk('lib')].map(p => [p, read(p)] as [string, string])
check('no refund or credit note is issued outside lib/order/native-refund.ts', () => { const s = strayRefunds(ALL); ok(!s.length, s.join(', ')) })
check('  control: a stray refunds.create is caught', () => {
  ok(strayRefunds([['app/api/promo/redeem/route.ts', 'await stripe.refunds.create({ payment_intent: pi, amount: 1 })']]).length === 1, 'vacuous')
})
check('the FamilyMeal-processed edit refund goes through refundPaymentFromRestaurant', () => {
  ok(/refundPaymentFromRestaurant\(stripe, .*'order_edit'\)/.test(read('app/api/restaurant/orders/[ref]/edit/route.ts')), 'edit route')
})
const callers: Array<[string, string]> = [
  ['app/api/admin/orders/[ref]/refund/route.ts', 'admin_refund'],
  ['app/api/restaurant/orders/[ref]/refund/route.ts', 'restaurant_refund'],
  ['app/api/restaurant/orders/[ref]/edit/route.ts', 'order_edit'],
  ['lib/order/native-payment-succeeded.ts', 'sold_out_auto_refund'],
]
for (const [file, via] of callers) {
  check(`${file} says it is ${via}`, () => ok(new RegExp(`refundNativeOrder\\(.*\\{ via: '${via}' \\}\\)`).test(read(file)), 'via missing'))
}
check('  control: a caller without via fails', () => {
  const s = read('app/api/restaurant/orders/[ref]/edit/route.ts').replace(", { via: 'order_edit' })", ')')
  ok(!/refundNativeOrder\(.*\{ via: 'order_edit' \}\)/.test(s), 'vacuous')
})
const MIG = read('lib/migrations/009_disco_money_failures.sql')
const LIB = read('lib/order/money-failures.ts')
check('the table accepts every kind and via the code can write', () => {
  for (const k of ['refund_refused', 'payout_not_reversed', 'refund_from_disco_funds']) ok(MIG.includes(`'${k}'`) && LIB.includes(`'${k}'`), k)
  for (const v of ['admin_refund', 'restaurant_refund', 'order_edit', 'sold_out_auto_refund', 'unknown']) ok(MIG.includes(`'${v}'`) && LIB.includes(`'${v}'`), v)
  ok(/GRANT SELECT ON disco_money_failures TO crm_readonly/.test(MIG), 'grant')
})
check('the record never throws: the insert sits inside try/catch', () => ok(/try \{\s*await sql`\s*INSERT INTO disco_money_failures/.test(LIB) && /\} catch \(e\) \{/.test(LIB), 'not guarded'))

console.log(failures.length ? `\nFAILED ${failures.length}: ${failures.join(', ')}` : `\nALL PASS ${passed} passed`)
if (failures.length) process.exit(1)
