// Guards for the #ops-alerts wording (lib/ops-alert-format.ts), approved word for
// word by Kevin 2026-10-23. Run: npx tsx scripts/tests/ops-alert-format.test.ts
//
//   1. The rendered shape: emoji + bold headline, body lines, "What to do", link —
//      and NEVER raw JSON, whatever the alert's context holds.
//   2. "Order email not delivered" says whether the diner or the restaurant bounced
//      (subject first, recipient second) and shows a diner's address as …@domain.
//   3. Bounce reasons, Stripe errors, halt reasons and times said in words.
//   4. The transient-failure thresholds, measured against #ops-alerts history.
//   5. Source guards: no call site passes a string (the old `alertOps(message, {json})`
//      shape), nothing renders context into Slack, and both docs name #ops-alerts.
//      Each control-tested against a doctored copy.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderAlert, renderReply, renderTopLevelResolve, emailSide, maskDinerEmail, bounceReason, formatWhen, formatDay,
  orderLink, money, shortError, haltReasonInWords, jobFailureAlert, jobRecoveredText, JOBS,
} from '../../lib/ops-alert-format'
import { stripeSaid } from '../../lib/order/money-alerts'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}:\n    expected ${JSON.stringify(b)}\n    got      ${JSON.stringify(a)}`) }
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg) }

console.log('\n=== rendered shape ===')
check('courier alert renders exactly as approved', () => eq(renderAlert({
  severity: 'urgent',
  headline: 'Courier not booked — order #900000463',
  lines: ['Apollo Bagels - Hoboken · delivery Tue Oct 20, 7:45 AM EDT · $74.78',
    'Expedite turned the booking down: "Not operational in this region." Disco retries every 15 minutes until 20 minutes before pickup.'],
  action: "if it's still failing an hour before pickup, book a courier another way.",
  link: orderLink('c6b2af44-d4c3-4ead-96c7-8844fd3b5436', '900000463'),
}), [
  ':rotating_light: *Courier not booked — order #900000463*',
  'Apollo Bagels - Hoboken · delivery Tue Oct 20, 7:45 AM EDT · $74.78',
  'Expedite turned the booking down: "Not operational in this region." Disco retries every 15 minutes until 20 minutes before pickup.',
  "*What to do:* if it's still failing an hour before pickup, book a courier another way.",
  '<https://dashboard.discocater.com/orders/c6b2af44-d4c3-4ead-96c7-8844fd3b5436|Open order #900000463 in NM OS>',
].join('\n'), 'courier'))
check('context NEVER reaches the Slack text', () => {
  const t = renderAlert({ headline: 'H', context: { secret: 'xyzzy', nested: { a: 1 } } })
  ok(!t.includes('xyzzy') && !t.includes('{') && !t.includes('nested'), t)
})
check('empty lines are dropped, default severity is warn', () => eq(renderAlert({ headline: 'H', lines: ['', '  ', 'a'] }), ':warning: *H*\na', 'blank'))
check('Slack control characters are escaped, links are not', () => {
  const t = renderAlert({ headline: 'A & B <c>', link: { url: 'https://x.test/a?b=1&c=2', label: 'L <1>' } })
  eq(t, ':warning: *A &amp; B &lt;c&gt;*\n<https://x.test/a?b=1&c=2|L &lt;1&gt;>', 'escape')
})
check('resolved reply and escalation reply', () => {
  eq(renderReply('Resolved: the order was cancelled.', { resolved: true }), ':white_check_mark: Resolved: the order was cancelled.', 'resolved')
  eq(renderReply("Pickup is in 7 minutes and there's still no courier.", { severity: 'warn', action: 'call the restaurant and the diner now.' }),
    ":warning: Pickup is in 7 minutes and there's still no courier. *What to do:* call the restaurant and the diner now.", 'escalation')
})
check('webhook fallback resolve names the alert it closes', () =>
  eq(renderTopLevelResolve('Restaurant not paid — order #900000303', 'Resolved: a payout to the restaurant is now recorded.'),
    ':white_check_mark: *Restaurant not paid — order #900000303*\nResolved: a payout to the restaurant is now recorded.', 'fallback'))

console.log('\n=== order email: which side, and the diner mask ===')
check('diner receipt subject → diner, even when the address no longer matches (#900000476)', () =>
  eq(emailSide({ subject: 'New Disco Cater Order — The Speakeatery #900000476', recipient: 'magooobooo@gmail.fom', orderNumber: '900000476', customerEmail: 'fixed@gmail.com' }), 'diner', '476'))
check('restaurant notification subject → restaurant (#900000499)', () =>
  eq(emailSide({ subject: "Hugo's Studio City — Order 900000499 ($420.63) 10/21/2026, 8:30 AM for MARLENA DAVIS", recipient: 'stucity@hugos.us', orderNumber: '900000499' }), 'restaurant', '499'))
check('no subject: recipient decides', () => {
  eq(emailSide({ subject: '', recipient: 'A@x.com', orderNumber: '1', customerEmail: 'a@x.com' }), 'diner', 'diner by recipient')
  eq(emailSide({ subject: null, recipient: 'ops@r.com', orderNumber: '1', restaurantEmails: ['a@r.com, ops@r.com'] }), 'restaurant', 'restaurant by list')
  eq(emailSide({ subject: 'Something else', recipient: 'z@z.com', orderNumber: '1' }), 'unknown', 'unknown')
})
check('a diner address shows only …@domain', () => {
  eq(maskDinerEmail('oliviaujlaki@gmail.con'), '…@gmail.con', 'mask')
  eq(maskDinerEmail('nodomain'), '…', 'no @')
})

console.log('\n=== said in words ===')
check('bounce reasons from the real #ops-alerts failures', () => {
  eq(bounceReason('498 No MX for gmail.con, lookup gmail.con. on 172.17.0.1:53: no such host', 'x@gmail.con'), "It bounced because gmail.con doesn't exist (likely a typo).", 'no MX')
  eq(bounceReason('550 JunkMail rejected - v5241.v51e342bd.use4.send.mailgun.net [69.72.42.241]:53668 is in an RBL:', 'stucity@hugos.us'), 'Their mail server blocked it as spam (our sending server was on a blocklist).', 'RBL')
  eq(bounceReason('550 permanent failure for one or more recipients (dayanaral@prudentialuniforms.com:blocked)', 'd@p.com'), 'Their mail server refused it.', 'blocked')
  ok(bounceReason('451 try later', 'a@b.c').startsWith('Mailgun said: "451 try later"'), 'fallback')
})
check('Stripe errors from the real #ops-alerts failures', () => {
  eq(stripeSaid(new Error('Transfers using this transaction as a source must not exceed the source amount of $385.90.')), 'Stripe said the transfer was larger than the payment ($385.90).', 'over')
  eq(stripeSaid('The recipient of this transfer does not have sufficient funds in their Stripe balance to reverse this amount.'), "Stripe said the restaurant's balance was too low.", 'funds')
})
check('a JSON error body is said by its message, never its braces', () =>
  eq(shortError('Mailgun events 500: {\n  "message": "Internal server error"\n}'), 'Mailgun events 500: Internal server error', 'json'))
check('long errors are bounded', () => ok(shortError('x'.repeat(500)).length === 120, 'length'))
check('campaign halt reasons', () => {
  eq(haltReasonInWords('hard bounces 3.10% over the last 1204 sends (37 of 1204, limit 2%)'), 'Bounces hit 3.1% of the last 1,204 sent (the limit is 2%).', 'bounce')
  eq(haltReasonInWords('5 consecutive send failures (limit 5)'), '5 sends in a row failed (the limit is 5).', 'consecutive')
  eq(haltReasonInWords('Mailgun auth error: 401'), 'Mailgun auth error: 401.', 'other')
})
check("times in the restaurant's zone, with its label", () => {
  eq(formatWhen('2026-10-21T15:30:00Z', 'America/Los_Angeles'), 'Wed Oct 21, 8:30 AM PDT', 'LA')
  eq(formatWhen('2026-10-20T11:45:00Z', 'America/New_York'), 'Tue Oct 20, 7:45 AM EDT', 'NY')
  eq(formatWhen('2026-10-20T11:45:00Z', 'Not/AZone'), 'Tue Oct 20, 7:45 AM EDT', 'bad zone falls back to Eastern')
  eq(formatDay('2026-10-25'), 'Sun Oct 25', 'calendar day, no zone shift')
})
check('money', () => { eq(money(420.63), '$420.63', 'a'); eq(money('1204'), '$1,204.00', 'b'); eq(money(null), '$?', 'null') })

console.log('\n=== transient-failure thresholds (Kevin, 2026-10-23) ===')
check('5–15-minute jobs wait for 3, hourly for 2, daily alert at once', () => {
  eq(JOBS['mailgun-failures'].threshold, 3, 'mailgun */5')
  eq(JOBS['refresh-restaurant-admin-list'].threshold, 3, 'admin list */15')
  eq(JOBS['mirror-online-ordering'].threshold, 3, 'mirror */15')
  eq(JOBS['retry-expedite-dispatch'].threshold, 2, 'courier retry')
  eq(JOBS['sync-fm-orders'].threshold, 2, 'hourly')
  for (const j of ['menu-drift-check', 'reconcile-money-flow', 'reconcile-promo-codes', 'reconcile-stripe-links', 'refresh-map-cache', 'sync-restaurants', 'check-fm-order-gaps']) eq(JOBS[j].threshold, 1, j)
})
check('every job a route reports on is in the table', () => {
  const routes = walk('app/api/cron').filter(f => f.endsWith('route.ts'))
  for (const f of routes) {
    for (const m of readFileSync(f, 'utf8').matchAll(/noteJob(?:Failure|Success)\('([^']+)'/g)) ok(JOBS[m[1]], `${f}: ${m[1]} has no JOBS entry`)
  }
})
check('job failure message, and the recovered reply', () => {
  const a = jobFailureAlert('mailgun-failures', 3, 'Mailgun events 500: {"message": "Internal server error"}')
  eq(renderAlert(a), [
    ':warning: *Bounced-email check has failed 3 runs in a row*',
    `Bounced order emails aren't being picked up while this is down. Last error: "Mailgun events 500: Internal server error".`,
    "*What to do:* nothing if it recovers on its own; if it's still failing in an hour, check Mailgun's status page.",
  ].join('\n'), 'job')
  eq(jobRecoveredText(3, new Date('2026-10-23T09:25:00Z')), 'Recovered: it ran fine at 5:25 AM after 3 failures.', 'recovered')
})

console.log('\n=== source guards ===')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    if (n === 'node_modules' || n.startsWith('.')) return []
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}
const SOURCES = [...walk('app'), ...walk('lib'), ...walk('scripts').filter(f => !f.includes('scripts/tests/'))]
const OLD_SHAPE = /\balertOps\(\s*[`'"]|\balertOnce\([^,]+,\s*[`'"]/
function oldShapeSites(files: Array<{ f: string; src: string }>): string[] {
  return files.filter(x => OLD_SHAPE.test(x.src)).map(x => x.f)
}
check('no call site passes a message string (the old `alertOps(text, {json})` shape)', () => {
  const bad = oldShapeSites(SOURCES.map(f => ({ f, src: readFileSync(f, 'utf8') })))
  eq(bad, [], 'string-shaped calls')
})
check('CONTROL: the guard catches the pre-2026-10-23 shape', () => {
  const doctored = `await alertOps('mailgun-failures: FAILED', { error })`
  eq(oldShapeSites([{ f: 'doctored.ts', src: doctored }]), ['doctored.ts'], 'control')
})
check('renderAlert never touches context', () => {
  const src = readFileSync('lib/ops-alert-format.ts', 'utf8')
  const body = src.slice(src.indexOf('export function renderAlert'), src.indexOf('export function renderReply'))
  ok(!/context|JSON\.stringify/.test(body), 'renderAlert reads context')
})
check('CONTROL: that guard fails on a renderer that dumps context', () => {
  const doctored = 'export function renderAlert(a) { return JSON.stringify(a.context) }\nexport function renderReply'
  const body = doctored.slice(doctored.indexOf('export function renderAlert'), doctored.indexOf('export function renderReply'))
  ok(/context|JSON\.stringify/.test(body), 'control did not trip')
})
check('the docs name #ops-alerts, not #notifications', () => {
  for (const f of ['lib/ops-alert.ts', '.env.local.example']) {
    const src = readFileSync(f, 'utf8')
    ok(!/#notifications/.test(src), `${f} still says #notifications`)
    ok(/#ops-alerts/.test(src), `${f} does not name #ops-alerts`)
  }
})

console.log(`\n${failures.length ? `FAILED ${failures.length}: ${failures.join(' | ')}` : 'ALL PASS'} — ${passed} passed`)
if (failures.length) process.exit(1)
