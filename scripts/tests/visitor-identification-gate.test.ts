// Guards for the RB2B / Apollo page rule (lib/visitor-identification.ts) and its one loader
// (app/components/VisitorIdentification.tsx). Run: npx tsx scripts/tests/visitor-identification-gate.test.ts
//
//   1. The rule: every excluded and every allowed path, including the near-misses that a
//      plain startsWith would get wrong (/order-confirmation vs /order, /restaurants vs /restaurant).
//   2. Source guards: neither vendor loads anywhere but the component, and the component asks
//      the rule before loading either. Each is control-tested against a doctored copy of the
//      real file text, so none of them passes vacuously.
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { visitorIdentificationAllowed as allowed } from '../../lib/visitor-identification'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg) }

const WWW = 'www.discocater.com'

console.log('\n=== excluded (1P, already-known, logged-in portal) ===')
for (const p of [
  '/order/birdandco', '/order/birdandco/', '/order/maciels/thanksgiving', '/order/FrancescaCatering-GlenRock', '/order',
  '/locations/eggbred', '/locations',
  '/order-confirmation/e9605bcf-1796-4100-89b9-af9ba11fbbf5',
  '/account', '/account/orders', '/account/orders/history',
  '/restaurant', '/restaurant/orders', '/restaurant/orders/create', '/restaurant/dashboard', '/restaurant/select-location',
  '/restaurant/manage/locations', '/restaurant/menu-manager', '/restaurant/account/profile',
]) check(`${p} is excluded`, () => ok(!allowed(p, WWW), 'allowed'))

console.log('\n=== allowed (3P diners and restaurant prospects) ===')
for (const p of [
  '/', '/fullmap', '/restaurants', '/restaurants/birdandco', '/new-york', '/for-restaurants', '/become-a-partner',
  '/faq', '/signup', '/corporate-catering',
  '/restaurant/login', '/restaurant/accept-invite', '/restaurant/forgot-password', '/restaurant/login/',
]) check(`${p} is allowed`, () => ok(allowed(p, WWW), 'excluded'))

check('a query string does not change the answer', () => ok(!allowed('/order/x?utm_source=site', WWW) && allowed('/?ref=/order/x', WWW), 'query'))

console.log('\n=== restaurant.discocater.com (rewritten onto /restaurant/*) ===')
check('portal pages excluded on the subdomain', () => ok(!allowed('/orders', 'restaurant.discocater.com') && !allowed('/', 'restaurant.discocater.com'), 'allowed'))
check('pre-session pages kept on the subdomain', () => ok(allowed('/login', 'restaurant.discocater.com') && allowed('/accept-invite', 'restaurant.discocater.com'), 'excluded'))
check('already-prefixed paths on the subdomain are not double-prefixed', () => ok(allowed('/restaurant/login', 'restaurant.discocater.com') && !allowed('/restaurant/orders', 'restaurant.discocater.com'), 'prefix'))

console.log('\n=== source guards ===')
const layout = readFileSync('app/layout.tsx', 'utf8')
const component = readFileSync('app/components/VisitorIdentification.tsx', 'utf8')
const VENDOR = /ddwl4m2hdecbv\.cloudfront\.net|assets\.apollo\.io/
const layoutHasNoVendor = (src: string) => !VENDOR.test(src)
const gatesBothVendors = (src: string) => {
  const gate = src.indexOf('visitorIdentificationAllowed(pathname')
  const rb = src.indexOf("loadRb2b('")
  const ap = src.indexOf("loadApollo('")
  return gate > 0 && rb > gate && ap > gate && /if \(isInternal\(\)\) return/.test(src.slice(gate, Math.min(rb, ap)))
}
check('app/layout.tsx loads neither vendor directly', () => ok(layoutHasNoVendor(layout), 'vendor snippet found in layout'))
check('  control: a vendor snippet put back in the layout is caught', () => ok(!layoutHasNoVendor(layout + '\n<Script>{`o.src="https://assets.apollo.io/micro/website-tracker/tracker.iife.js"`}</Script>'), 'not caught'))
check('app/layout.tsx mounts <VisitorIdentification />', () => ok(/<VisitorIdentification \/>/.test(layout), 'not mounted'))
check('the component asks the rule, then the internal cookie, before loading either vendor', () => ok(gatesBothVendors(component), 'ungated'))
check('  control: removing the rule check is caught', () => ok(!gatesBothVendors(component.replace(/if \(!visitorIdentificationAllowed\(pathname[^\n]*\n/, '')), 'not caught'))
check('  control: removing the internal-cookie skip is caught', () => ok(!gatesBothVendors(component.replace(/if \(isInternal\(\)\) return\n/, '')), 'not caught'))
check('no other file loads either vendor', () => {
  // Scoped to the source roots; the vendors' hostnames appear nowhere else in app/ or lib/.
  const hits = execSync("git grep --untracked -l -E 'ddwl4m2hdecbv\\.cloudfront\\.net|assets\\.apollo\\.io' -- app lib components hooks || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  ok(hits.length === 1 && hits[0] === 'app/components/VisitorIdentification.tsx', `found in: ${hits.join(', ')}`)
})

console.log(`\n${failures.length ? 'FAILED' : 'ALL PASS'} ${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join('; ')}` : ''}`)
if (failures.length) process.exit(1)
