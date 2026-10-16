// Guards for NM OS's do-not-contact check on the bulk campaign senders
// (lib/marketing/nm-do-not-contact.ts). Run: npx tsx scripts/tests/campaign-dnc-guard.test.ts
//
// Two kinds of check:
//   1. parseCheckResponse fails closed on every answer that is not a usable 200.
//   2. Source guards: runCampaign loads the list before its loop and checks it
//      before claim(), and both scripts filter their recipient lists through it.
//      Each source guard is control-tested by removing the call from the real
//      file text and requiring the guard to fail, so none of them is vacuous.
import { readFileSync } from 'node:fs'
import { parseCheckResponse, NmDoNotContactUnavailable } from '../../lib/marketing/nm-do-not-contact'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg) }
function throwsUnavailable(fn: () => unknown, msg: string) {
  try { fn() } catch (e) { ok(e instanceof NmDoNotContactUnavailable, `${msg}: wrong error ${(e as Error).message}`); return }
  throw new Error(`${msg}: did not throw`)
}

console.log('\n=== parseCheckResponse fails closed ===')
check('a well-formed 200 is accepted', () => {
  const r = parseCheckResponse(200, { blocked: ['a@b.com'], checked: 2, activeSuppressions: 773 }, 2)
  ok(r.blocked.length === 1 && r.activeSuppressions === 773, 'parsed')
})
check('503 (secret not set on NM OS) refuses', () => throwsUnavailable(() => parseCheckResponse(503, { error: 'check not configured' }, 1), '503'))
check('401 refuses', () => throwsUnavailable(() => parseCheckResponse(401, { error: 'Unauthorized' }, 1), '401'))
check('500 refuses', () => throwsUnavailable(() => parseCheckResponse(500, null, 1), '500'))
check('a malformed body refuses', () => throwsUnavailable(() => parseCheckResponse(200, { blocked: 'x' }, 1), 'malformed'))
check('a short answer (checked != sent) refuses', () =>
  throwsUnavailable(() => parseCheckResponse(200, { blocked: [], checked: 1, activeSuppressions: 5 }, 2), 'short'))
check('zero active suppressions refuses (wrong database, not an empty list)', () =>
  throwsUnavailable(() => parseCheckResponse(200, { blocked: [], checked: 1, activeSuppressions: 0 }, 1), 'zero'))

console.log('\n=== every sender checks NM OS before it claims or sends ===')
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
type Guard = { file: string; call: string; before: string; what: string }
const GUARDS: Guard[] = [
  { file: 'lib/marketing/campaign-send.ts', call: 'await dnc.load()', before: 'for (let i = 0; i < recipients.length; i++)', what: 'runCampaign loads the list before the send loop' },
  { file: 'lib/marketing/campaign-send.ts', call: 'if (await dnc.isBlocked(r.email))', before: "withDbRetry('claim'", what: 'runCampaign checks each recipient before claim()' },
  { file: 'scripts/diner-announce-send.ts', call: 'await nmBlockedEmails(built.map(r => r.email))', before: 'await runCampaign(', what: 'diner announcement filters its recipient list' },
  { file: 'scripts/rebrand-campaign-send.ts', call: 'await nmBlockedEmails(targets.map(r => r.email))', before: 'await runCampaign(', what: 'rebrand filters its targets' },
]
function guardHolds(text: string, g: Guard): string | null {
  const at = text.indexOf(g.call)
  if (at < 0) return 'call missing'
  const side = text.indexOf(g.before)
  if (side < 0) return `marker not found: ${g.before}`
  if (side < at) return 'side effect comes before the check'
  return null
}
for (const g of GUARDS) {
  check(g.what, () => { const why = guardHolds(src(g.file), g); ok(why === null, `${g.file}: ${why}`) })
  check(`CONTROL: removing it from ${g.file} fails the guard`, () => {
    ok(guardHolds(src(g.file).replace(g.call, 'removedForControl()'), g) !== null, 'guard is vacuous')
  })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
