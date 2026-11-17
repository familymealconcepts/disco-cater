// Guards for the "Stripe Connected" Slack alert (notifyStripeConnectedOnChange, app/api/stripe/webhook).
// Run: npx tsx scripts/tests/stripe-connected-alert.test.ts
//
//   1. It fires on a CHANGE from unable to able to accept payments (charges_enabled false -> true), compared
//      with the state the webhook saved last time, or Stripe's previous_attributes when nothing is saved.
//      Crispy Karma, The Onion Tree - Sea Cliff and Son del North were alerted months after connecting
//      because the old rule fired the first time Disco saw an account connected.
//   2. Once per restaurant: the claim is one conditional UPDATE that records the alert.
//   3. The saved state is the webhook's own column, never the capability job's stripe_charges_enabled.
import { readFileSync } from 'node:fs'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function ok(c: boolean, msg: string) { if (!c) throw new Error(msg) }

const route = readFileSync('app/api/stripe/webhook/route.ts', 'utf8')
const fn = route.slice(route.indexOf('export async function notifyStripeConnectedOnChange('), route.indexOf('export async function POST('))
const code = fn.replace(/\/\/.*$/gm, '')

console.log('\n=== Stripe Connected alert ===')
check('compares with the previous saved state and only fires on unable -> able', () => {
  ok(/stripe_webhook_charges_enabled = false\s+OR \(stripe_webhook_charges_enabled IS NULL AND \$\{wasAbleInEvent\}::boolean = false\)/.test(code), 'claim requires a saved or Stripe-reported "unable" before')
  ok(code.includes("'charges_enabled' in previous"), 'reads previous_attributes')
  ok(route.includes('await notifyStripeConnectedOnChange(account, event.data.previous_attributes'), 'account.updated passes previous_attributes')
  ok(!/details_submitted|fullyConnected/.test(code), 'the old "seen connected" rule is gone')
})
check('once per restaurant, recorded atomically', () => {
  ok(/SET stripe_connected_notified_at = NOW\(\)[\s\S]*?WHERE stripe_account_id = \$\{account\.id\} AND stripe_connected_notified_at IS NULL/.test(code), 'conditional claim')
  ok(code.indexOf('RETURNING restaurant_reference') < code.indexOf('if (claimed.length === 0) return'), 'only a claimed row reaches Slack')
})
check("the saved state is the webhook's own column", () => {
  ok(/SET stripe_webhook_charges_enabled = \$\{able\}/.test(code), 'every event records the state')
  ok(!/stripe_charges_enabled/.test(code), "never the capability job's column")
  ok(readFileSync('lib/db.ts', 'utf8').includes('ADD COLUMN IF NOT EXISTS stripe_webhook_charges_enabled BOOLEAN'), 'column migration')
  ok(!readFileSync('lib/stripe-capability-refresh.ts', 'utf8').includes('stripe_webhook_charges_enabled'), 'the job never writes it')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
