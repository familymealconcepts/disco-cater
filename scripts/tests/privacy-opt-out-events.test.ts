// Guards for browser ad opt-outs recorded against an email (lib/privacy-opt-out-events.ts, table
// 007_privacy_opt_out_events.sql). Run: npx tsx scripts/tests/privacy-opt-out-events.test.ts
//
//   1. Which opt-out a checkout carries: the Sec-GPC header, else the drawer's flag; GPC wins.
//   2. Emails are normalized and de-duplicated.
//   3. Source guards: the flag never reaches FamilyMeal, both placement paths record, Direct Entry
//      never sends the flag, the switch route takes the email from the session and refuses an
//      opt_in under GPC, and the table only lets the switch opt back in. Each control-tested
//      against a doctored copy of the real file text.
import { readFileSync } from 'node:fs'
import { checkoutOptOutSource, optOutEmails } from '../../lib/privacy-opt-out-events'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg) }
const read = (p: string) => readFileSync(p, 'utf8')

console.log('\n=== which opt-out a checkout carries ===')
check('Sec-GPC: 1 is GPC, whatever the flag says', () => {
  eq(checkoutOptOutSource('1', false), 'checkout_gpc', 'gpc, flag false')
  eq(checkoutOptOutSource(' 1 ', true), 'checkout_gpc', 'gpc wins over the switch')
})
check('the switch flag alone is the switch', () => eq(checkoutOptOutSource(null, true), 'checkout_switch', 'switch'))
check('nothing, a 0 header, or a truthy non-boolean flag records nothing', () => {
  eq(checkoutOptOutSource(null, false), null, 'none')
  eq(checkoutOptOutSource('0', undefined), null, 'header 0')
  eq(checkoutOptOutSource(null, 'true'), null, 'string flag')
})
check('emails: trimmed, lowercased, de-duplicated, junk dropped', () =>
  eq(optOutEmails(' Diner@X.com', 'diner@x.com', 'other@y.com', '', null, 42, 'no-at'), ['diner@x.com', 'other@y.com'], 'emails'))

console.log('\n=== source guards ===')
const ROUTE = 'app/api/order/place/route.ts'
const route = read(ROUTE)
const stripsFlag = (s: string) => {
  const del = s.indexOf('delete (body as Record<string, unknown>).privacyOptOut')
  const forward = s.indexOf('...placeBody } = body')
  return del > 0 && forward > 0 && del < forward
}
check('the place route strips privacyOptOut before the body is forwarded to FamilyMeal', () => ok(stripsFlag(route), 'flag reaches FM'))
check('  control: without the delete, the guard fails', () => ok(!stripsFlag(route.replace('delete (body as Record<string, unknown>).privacyOptOut', '')), 'vacuous'))
const recordsOnBoth = (s: string) => (s.match(/recordPrivacyOptOutEvents\(/g) ?? []).length === 2 && /checkoutOptOutSource\(req\.headers\.get\('sec-gpc'\)/.test(s)
check('both placement paths (native and FM-backed) record an opt-out', () => ok(recordsOnBoth(route), 'missing a path'))
check('  control: one call removed fails', () => ok(!recordsOnBoth(route.replace('waitUntil(recordPrivacyOptOutEvents(', 'waitUntil((')), 'vacuous'))
const drawer = read('app/(customer)/restaurants/[slug]/CheckoutDrawer.tsx')
const drawerGuard = (s: string) => /\.\.\.\(!isDirectEntry \? \{ privacyOptOut: adTrackingOptedOut\(\) \} : \{\}\)/.test(s)
check('the drawer sends the flag on the customer flow only, never Direct Entry', () => ok(drawerGuard(drawer), 'drawer'))
check('  control: an unconditional flag fails', () => ok(!drawerGuard(drawer.replace('...(!isDirectEntry ? { privacyOptOut: adTrackingOptedOut() } : {})', 'privacyOptOut: adTrackingOptedOut()')), 'vacuous'))
const sw = read('app/api/customer/privacy-choices/route.ts')
check('the switch route takes the email from the session, never the body', () => {
  ok(/optOutEmails\(session\.email\)/.test(sw), 'session email')
  ok(!/body\.email/.test(sw), 'body email read')
})
check('the switch route refuses an opt_in under GPC', () => ok(/!body\.optOut && req\.headers\.get\('sec-gpc'\)/.test(sw), 'gpc guard'))
const page = read('app/(customer)/privacy-choices/PrivacyChoicesSwitch.tsx')
check('the /privacy-choices switch calls the route', () => ok(/onChange=\{setOptOut\}/.test(page) && /\/api\/customer\/privacy-choices/.test(page), 'switch not wired'))
const mig = read('lib/migrations/007_privacy_opt_out_events.sql')
check('the table only lets the switch opt back in, and NM OS can read it', () => {
  ok(/CHECK \(kind = 'opt_out' OR source = 'privacy_choices_switch'\)/.test(mig), 'opt_in source check')
  ok(/GRANT SELECT ON privacy_opt_out_events TO crm_readonly/.test(mig), 'grant')
})

console.log(failures.length ? `\nFAILED ${failures.length}: ${failures.join(', ')}` : `\nALL PASS ${passed} passed`)
if (failures.length) process.exit(1)
