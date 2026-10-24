// Team browsers (disco_internal=true, set from NM OS's "Disco Cater team browser" page) are excluded
// from every tag (Kevin, item #61, 2026-10-24). This guard fails if a loader stops checking the
// cookie, or if GA4's internal tag moves back after config (which left each visit's first page_view
// untagged).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const CHECK = "document.cookie.includes('disco_internal=true')"
let n = 0
const ok = (label: string, fn: () => void) => { fn(); n++; console.log(`  PASS  ${label}`) }

console.log('\ninternal-traffic guard')

const layout = read('app/layout.tsx')

/** Index of `gtag('config'` and of the traffic_type set, in the GA4 script. */
export function ga4Order(src: string): { set: number; config: number } {
  return { set: src.indexOf("gtag('set', { 'traffic_type': 'internal' })"), config: src.indexOf("gtag('config', 'G-KQV7RLHXTH')") }
}

ok('GA4: traffic_type is set BEFORE config, so the first page_view is tagged', () => {
  const { set, config } = ga4Order(layout)
  assert.ok(set > 0, 'the traffic_type set is missing')
  assert.ok(config > 0, 'the GA4 config call is missing')
  assert.ok(set < config, 'traffic_type must be set before gtag(config)')
})

ok('CONTROL: the old order (set after config) is caught', () => {
  const old = "gtag('config', 'G-KQV7RLHXTH');\n if (x) { gtag('set', { 'traffic_type': 'internal' }); }"
  const { set, config } = ga4Order(old)
  assert.ok(!(set > 0 && config > 0 && set < config))
})

ok('Meta and LinkedIn check the cookie (layout)', () => {
  assert.ok(layout.split(CHECK).length - 1 >= 3, 'layout must check disco_internal for GA4, LinkedIn and Meta')
})

ok('Clarity checks the cookie before loading', () => {
  const clarity = read('app/components/ClarityLoader.tsx')
  assert.ok(clarity.includes(CHECK), 'ClarityLoader must check disco_internal')
  assert.ok(clarity.indexOf('if (isInternalBrowser()) return') < clarity.indexOf('loadClarity(\'vv8ibgkwby\')'), 'the check must come before the load')
})

ok('RB2B / Apollo check the cookie', () => {
  assert.ok(read('app/components/VisitorIdentification.tsx').includes(CHECK))
})

console.log(`\nALL PASS  ${n} assertions`)
