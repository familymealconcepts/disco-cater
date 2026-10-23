// Guards for the email-typo hint (lib/email-typo.ts, Kevin 2026-10-23).
// Run: npx tsx scripts/tests/email-typo.test.ts
//
//   1. Every vector in lib/email-typo-domains.json (the file shared with noise-machine).
//   2. The approved wording, word for word, at both entry points, and that neither blocks.
import { readFileSync } from 'node:fs'
import { suggestEmailCorrection, emailDomainOf } from '../../lib/email-typo'
import shared from '../../lib/email-typo-domains.json'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg) }

console.log('\n=== the shared vectors ===')
for (const v of shared.vectors as { email: string; suggest: string | null; why: string }[]) {
  check(`${JSON.stringify(v.email)} -> ${JSON.stringify(v.suggest)} (${v.why})`, () => eq(suggestEmailCorrection(v.email), v.suggest, v.email))
}
check('every listed typo suggests its correction, and one with no correction suggests nothing', () => {
  for (const [typo, fix] of Object.entries(shared.exact as Record<string, string | null>)) eq(suggestEmailCorrection(`pat@${typo}`), fix ? `pat@${fix}` : null, typo)
})
check('hmail.com gets no hint (ambiguous: gmail or hotmail; Kevin, 2026-10-23)', () => eq(suggestEmailCorrection('pat@hmail.com'), null, 'hmail'))
check('aol.co gets no hint (could be a cut-off aol.co.uk; Kevin, 2026-10-23)', () => eq(suggestEmailCorrection('pat@aol.co'), null, 'aol.co'))
check('a broken ending is fixed only on known free mail, never a company domain', () => {
  eq(suggestEmailCorrection('pat@gmail.con'), 'pat@gmail.com', 'free mail')
  eq(suggestEmailCorrection('pat@acme-catering.xom'), null, 'company')
  for (const name of shared.freeMail as string[]) eq(suggestEmailCorrection(`pat@${name.slice(0, -3)}con`), `pat@${name}`, name)
})
check('emailDomainOf gives the domain for the "Use ..." button', () => eq(emailDomainOf('pat@gmail.com'), 'gmail.com', 'domain'))

console.log('\n=== the approved wording, warn only ===')
const checkout = readFileSync('app/(customer)/restaurants/[slug]/CheckoutDrawer.tsx', 'utf8')
const settings = readFileSync('app/(restaurant)/restaurant/(portal)/order-settings/page.tsx', 'utf8')
check('checkout says "Did you mean {corrected address}?" with the address tappable', () => {
  ok(/Did you mean <button[^>]*onClick=\{\(\) => setContactEmail\(emailSuggestion\)\}[^>]*>\{emailSuggestion\}<\/button>\?/.test(checkout.replace(/\s+/g, ' ')), 'the checkout hint is not the approved sentence with a tappable address')
})
check('checkout never blocks on it: the suggestion is not in the missing-fields check', () => {
  ok(!/emailSuggestion[^\n]*&& 'email'/.test(checkout), 'a typo suggestion is being treated as a missing field')
})
check('Order Settings: "Did you mean {corrected address}?", "Use {corrected domain}" and "Add as typed"', () => {
  const flat = settings.replace(/\s+/g, ' ')
  ok(/Did you mean \{pendingSuggestion\}\?/.test(flat), 'the sentence')
  ok(/>Use \{emailDomainOf\(pendingSuggestion\)\}</.test(flat), 'the Use button')
  ok(/>Add as typed</.test(flat), 'the Add as typed button')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
