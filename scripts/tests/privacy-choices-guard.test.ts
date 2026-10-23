// Guards for the advertising opt-out (lib/privacy-choices.ts): Global Privacy Control or the
// /privacy-choices switch stops the Meta Pixel, the LinkedIn Insight Tag, RB2B and Apollo's
// website tracker, and denies Google's ad consent before GA4 is configured. And the separate
// optional-cookies choice (the banner): Clarity, RB2B and Apollo wait for Accept; GPC is Decline.
// Run: npx tsx scripts/tests/privacy-choices-guard.test.ts
//
//   1. The rule itself, both forms (the module's functions and the inline-script expression),
//      against a stubbed navigator and localStorage.
//   2. Source guards: every governed loader checks the rule. Each is control-tested against a
//      doctored copy of the real file text, so none of them passes vacuously.
import { readFileSync } from 'node:fs'
import { OPT_OUT_EXPR, PRIVACY_OPT_OUT_KEY, CONSENT_KEY, adTrackingOptedOut, consentChoice, optionalCookiesAllowed } from '../../lib/privacy-choices'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg) }

type Env = { gpc?: boolean; stored?: string | null; consent?: string | null; storageThrows?: boolean }
function withEnv<T>(env: Env, fn: () => T): T {
  const g = globalThis as Record<string, unknown>
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const prevLs = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'navigator', { value: env.gpc === undefined ? {} : { globalPrivacyControl: env.gpc }, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k: string) => { if (env.storageThrows) throw new Error('blocked'); return k === PRIVACY_OPT_OUT_KEY ? (env.stored ?? null) : k === CONSENT_KEY ? (env.consent ?? null) : null } },
    configurable: true,
  })
  try { return fn() } finally {
    if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav); else delete g.navigator
    if (prevLs) Object.defineProperty(globalThis, 'localStorage', prevLs); else delete g.localStorage
  }
}
const evalExpr = () => new Function(`return ${OPT_OUT_EXPR}`)() as boolean

console.log('\n=== the rule ===')
const CASES: [string, Env, boolean][] = [
  ['GPC on', { gpc: true }, true],
  ['switch on', { stored: '1' }, true],
  ['GPC on and switch on', { gpc: true, stored: '1' }, true],
  ['neither', {}, false],
  ['GPC false', { gpc: false }, false],
  ['switch holds something other than 1', { stored: 'true' }, false],
  ['storage blocked, no GPC', { storageThrows: true }, false],
  ['storage blocked, GPC on', { gpc: true, storageThrows: true }, true],
]
for (const [name, env, want] of CASES) {
  check(`module: ${name} -> ${want}`, () => ok(withEnv(env, adTrackingOptedOut) === want, 'wrong'))
  check(`inline expression: ${name} -> ${want}`, () => ok(withEnv(env, evalExpr) === want, 'wrong'))
}

console.log('\n=== the optional-cookies choice (banner) ===')
const CONSENT_CASES: [string, Env, 'accepted' | 'declined' | null][] = [
  ['no choice yet', {}, null],
  ['accepted', { consent: 'accepted' }, 'accepted'],
  ['declined', { consent: 'declined' }, 'declined'],
  ['an unknown stored value is no choice', { consent: 'yes' }, null],
  ['GPC reads as declined with nothing stored', { gpc: true }, 'declined'],
  ['GPC beats a stored accept', { gpc: true, consent: 'accepted' }, 'declined'],
  ['storage blocked is no choice', { storageThrows: true }, null],
  ['the ad opt-out switch does not touch it', { stored: '1', consent: 'accepted' }, 'accepted'],
]
for (const [name, env, want] of CONSENT_CASES) {
  check(`consentChoice: ${name} -> ${want}`, () => ok(withEnv(env, consentChoice) === want, 'wrong'))
  check(`optionalCookiesAllowed: ${name} -> ${want === 'accepted'}`, () => ok(withEnv(env, optionalCookiesAllowed) === (want === 'accepted'), 'wrong'))
}

console.log('\n=== source guards ===')
const layout = readFileSync('app/layout.tsx', 'utf8')
const component = readFileSync('app/components/VisitorIdentification.tsx', 'utf8')

function scriptBody(src: string, id: string): string {
  const start = src.indexOf(`<Script id="${id}"`)
  if (start < 0) return ''
  return src.slice(start, src.indexOf('</Script>', start))
}
const tagGated = (src: string, id: string) => scriptBody(src, id).includes('!${OPT_OUT_EXPR}')
const consentBeforeConfig = (src: string) => {
  const body = scriptBody(src, 'google-analytics')
  const gate = body.indexOf('if (${OPT_OUT_EXPR})')
  const consent = body.indexOf("gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })")
  const config = body.indexOf("gtag('config'")
  return gate >= 0 && consent > gate && config > consent
}
const vendorsGated = (src: string) => {
  const gate = src.indexOf('if (adTrackingOptedOut()) return')
  const rb = src.indexOf("loadRb2b('")
  const ap = src.indexOf("loadApollo('")
  return gate > 0 && rb > gate && ap > gate
}

for (const id of ['meta-pixel', 'linkedin-insight']) {
  check(`${id} checks the opt-out`, () => ok(tagGated(layout, id), 'ungated'))
  check(`  control: removing it from ${id} is caught`, () => ok(!tagGated(layout.replace(new RegExp(`(<Script id="${id}"[\\s\\S]*?) && !\\$\\{OPT_OUT_EXPR\\}`), '$1'), id), 'not caught'))
}
check('Google ad consent is denied before GA4 is configured', () => ok(consentBeforeConfig(layout), 'missing or after config'))
check('  control: moving the consent call after config is caught', () => {
  const body = scriptBody(layout, 'google-analytics')
  const moved = body.replace(/(\s*if \(\$\{OPT_OUT_EXPR\}\) \{[\s\S]*?\}\n)([\s\S]*?gtag\('config'[^\n]*\n)/, '$2$1')
  ok(moved !== body && !consentBeforeConfig(layout.replace(body, moved)), 'not caught')
})
check('the analytics config itself is not gated (GA4 stays)', () => ok(!/if \([^)]*\)\s*\{\s*gtag\('config'/.test(scriptBody(layout, 'google-analytics')), 'config is conditional'))
check('RB2B and Apollo load only after the opt-out check', () => ok(vendorsGated(component), 'ungated'))
check('  control: removing the opt-out check is caught', () => ok(!vendorsGated(component.replace(/ *if \(adTrackingOptedOut\(\)\) return\n/, '')), 'not caught'))

console.log('\n=== consent-gated loaders and the banner ===')
const clarity = readFileSync('app/components/ClarityLoader.tsx', 'utf8')
const banner = readFileSync('app/components/ConsentBanner.tsx', 'utf8')
// Gated: the consent check comes before every load call, and the loader re-runs on CONSENT_EVENT
// (that listener is what makes an Accept take effect with no reload).
const consentGated = (src: string, loads: string[]) => {
  const gate = src.indexOf('if (!optionalCookiesAllowed()) return')
  return gate > 0 && loads.every(l => src.indexOf(l) > gate) && /addEventListener\(CONSENT_EVENT, load\)/.test(src)
}
check('RB2B and Apollo load only after Accept, and react to it', () => ok(consentGated(component, ["loadRb2b('", "loadApollo('"]), 'ungated'))
check('  control: removing the consent check is caught', () => ok(!consentGated(component.replace(/ *if \(!optionalCookiesAllowed\(\)\) return\n/, ''), ["loadRb2b('", "loadApollo('"]), 'not caught'))
check('  control: removing the Accept listener is caught', () => ok(!consentGated(component.replace(/ *window\.addEventListener\(CONSENT_EVENT, load\)\n/, ''), ["loadRb2b('", "loadApollo('"]), 'not caught'))
check('Clarity loads only after Accept, and reacts to it', () => ok(consentGated(clarity, ["loadClarity('"]), 'ungated'))
check('  control: removing the consent check is caught', () => ok(!consentGated(clarity.replace(/ *if \(!optionalCookiesAllowed\(\)\) return\n/, ''), ["loadClarity('"]), 'not caught'))
check('Clarity does not read the ad opt-out (the banner alone controls it)', () => ok(!/adTrackingOptedOut|switchOptedOut/.test(clarity), 'reads the opt-out'))
const CLARITY_SRC = /clarity\.ms\/tag/
check('app/layout.tsx no longer loads Clarity directly', () => ok(!CLARITY_SRC.test(layout), 'Clarity snippet in layout'))
check('  control: the old inline snippet put back is caught', () => ok(CLARITY_SRC.test(layout + '\nt.src="https://www.clarity.ms/tag/"+i;'), 'not caught'))
check('app/layout.tsx mounts <ClarityLoader /> and <ConsentBanner />', () => ok(/<ClarityLoader \/>/.test(layout) && /<ConsentBanner \/>/.test(layout), 'not mounted'))
check('the banner shows only while there is no choice (so GPC, which reads as declined, never sees it)', () => ok(/const needsChoice = \(\) => consentChoice\(\) === null/.test(banner) && /if \(!show\) return null/.test(banner), 'wrong condition'))
check('the banner renders nothing on the server', () => ok(/const serverSnapshot = \(\) => false/.test(banner), 'server-rendered'))
check('the banner stacks above the restaurant order bar', () => ok(/'\.mobile-order-bar'/.test(banner) && /el\.style\.bottom = `\$\{h\}px`/.test(banner), 'no offset'))

console.log(`\n${failures.length ? 'FAILED' : 'ALL PASS'} ${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join('; ')}` : ''}`)
if (failures.length) process.exit(1)
