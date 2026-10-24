// Guards for Stripe's transfer.reversed, recorded against the order for NM OS's ops watch
// (lib/order/transfer-reversals.ts). Run: npx tsx scripts/tests/transfer-reversals.test.ts
//
//   1. The payload lists every reversal once, oldest first, with amounts in cents and nothing personal.
//   2. Only a transfer_group shaped like an order reference is looked up.
//   3. Source guards: the webhook handles the event through the shared function, the resolver checks
//      the three Disco sources in order and skips anything else, and a redelivered event writes nothing.
//      Each control-tested against a doctored copy.
import { readFileSync } from 'node:fs'
import { transferReversedPayload, orderReferenceCandidate, TRANSFER_REVERSED_EVENT } from '../../lib/order/transfer-reversals'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg) }
const read = (p: string) => readFileSync(p, 'utf8')

const transfer = { id: 'tr_1', amount: 5000, amount_reversed: 3500, reversed: false, currency: 'usd', transfer_group: '0b6f2c1e-1111-4a2b-9c3d-123456789abc' }

console.log('\n=== payload ===')
check('every reversal once, oldest first, in cents', () => {
  const p = transferReversedPayload('evt_1', transfer, [
    { id: 'trr_b', amount: 2500, created: 1_800_000_100 },
    { id: 'trr_a', amount: 1000, created: 1_800_000_000 },
    { id: 'trr_b', amount: 2500, created: 1_800_000_100 },
  ])
  eq(p.reversals.map((r) => [r.id, r.amountCents]), [['trr_a', 1000], ['trr_b', 2500]], 'reversals')
  eq(p.reversals[0].created, new Date(1_800_000_000 * 1000).toISOString(), 'created as ISO')
  eq([p.stripeEventId, p.transferId, p.amountCents, p.amountReversedCents, p.fullyReversed], ['evt_1', 'tr_1', 5000, 3500, false], 'transfer fields')
})
check('fully reversed is Stripe\'s own flag', () => eq(transferReversedPayload('e', { ...transfer, reversed: true }, []).fullyReversed, true, 'reversed'))
check('no personal data: only these keys', () => {
  const p = transferReversedPayload('e', transfer, [{ id: 'r', amount: 1, created: 1 }])
  eq(Object.keys(p).sort(), ['amountCents', 'amountReversedCents', 'currency', 'fullyReversed', 'reversals', 'stripeEventId', 'transferGroup', 'transferId'], 'keys')
  eq(Object.keys(p.reversals[0]).sort(), ['amountCents', 'created', 'id'], 'reversal keys')
})
check('the stored event type', () => eq(TRANSFER_REVERSED_EVENT, 'TRANSFER_REVERSED', 'type'))

console.log('\n=== transfer_group ===')
check('an order reference is looked up, lowercased', () => eq(orderReferenceCandidate(' 0B6F2C1E-1111-4A2B-9C3D-123456789ABC '), '0b6f2c1e-1111-4a2b-9c3d-123456789abc', 'uuid'))
check('anything else is not', () => { eq(orderReferenceCandidate('group_fm_123'), null, 'other'); eq(orderReferenceCandidate(null), null, 'null'); eq(orderReferenceCandidate(''), null, 'empty') })

console.log('\n=== source guards ===')
const ROUTE = read('app/api/stripe/webhook/route.ts')
const LIB = read('lib/order/transfer-reversals.ts')
const handled = (s: string) => /case 'transfer\.reversed': \{\s*await recordTransferReversed\(stripe, event\)/.test(s)
check('the webhook handles transfer.reversed through the shared function', () => ok(handled(ROUTE), 'case missing'))
check('  control: removing the case fails', () => ok(!handled(ROUTE.replace("case 'transfer.reversed':", "case 'transfer.nothing':")), 'vacuous'))

function resolverOrder(s: string): string | null {
  const body = s.slice(s.indexOf('export async function resolveTransferOrder'), s.indexOf('async function allReversals'))
  const at = ['FROM disco_money_failures', 'FROM disco_stripe_payments', 'orderReferenceCandidate(transferGroup)', 'FROM disco_orders'].map((k) => body.indexOf(k))
  if (at.some((i) => i < 0)) return 'a source is missing'
  for (let i = 1; i < at.length; i++) if (at[i] < at[i - 1]) return 'sources out of order'
  return null
}
check('the resolver checks failures, then payments, then an existing order', () => { const why = resolverOrder(LIB); ok(!why, why ?? '') })
check('  control: dropping the payments lookup fails', () => ok(resolverOrder(LIB.replace('FROM disco_stripe_payments', 'FROM nowhere')), 'vacuous'))

const skips = (s: string) => /if \(!orderReference\) \{[^}]*return\s*\}/.test(s)
check('an unknown transfer is skipped with no row', () => ok(skips(LIB), 'no skip'))
check('  control: removing the skip fails', () => ok(!skips(LIB.replace(/if \(!orderReference\) \{[^}]*return\s*\}/, '')), 'vacuous'))

const deduped = (s: string) => /WHERE NOT EXISTS[\s\S]{0,200}event_data->>'stripeEventId' = \$\{event\.id\}/.test(s)
check('a redelivered event writes nothing', () => ok(deduped(LIB), 'no dedupe'))
check('  control: removing the guard fails', () => ok(!deduped(LIB.replace('WHERE NOT EXISTS', 'WHERE TRUE OR EXISTS')), 'vacuous'))

console.log(`\n${failures.length ? `FAILED ${failures.length}` : 'ALL PASS'}  ${passed} passed`)
if (failures.length) process.exit(1)
