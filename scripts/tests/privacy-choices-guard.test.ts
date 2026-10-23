// Guards for the advertising opt-out (lib/privacy-choices.ts): Global Privacy Control or the
// /privacy-choices switch stops the Meta Pixel, the LinkedIn Insight Tag, RB2B and Apollo's
// website tracker, and denies Google's ad consent before GA4 is configured. Google consent mode
// is always on: the default is set before config for every visitor (ads granted unless opted out),
// and the switch sends a matching update when it changes, granted on switch-off unless GPC is on.
// And the separate optional-cookies choice (the banner): Clarity, RB2B and Apollo wait for Accept;
// GPC is Decline.
// Run: npx tsx scripts/tests/privacy-choices-guard.test.ts
//
//   1. The rule itself, both forms (the module's functions and the inline-script expression),
//      against a stubbed navigator and localStorage.
//   2. Source guards: every governed loader checks the rule. Each is control-tested against a
//      doctored copy of the real file text, so none of them passes vacuously.
import { readFileSync } from 'node:fs'
import { OPT_OUT_EXPR, PRIVACY_OPT_OUT_KEY, CONSENT_KEY, adTrackingOptedOut, consentChoice, optionalCookiesAllowed, setSwitchOptedOut } from '../../lib/privacy-choices'

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
    value: {
      getItem: (k: string) => { if (env.storageThrows) throw new Error('blocked'); return k === PRIVACY_OPT_OUT_KEY ? (env.stored ?? null) : k === CONSENT_KEY ? (env.consent ?? null) : null },
      setItem: (k: string, v: string) => { if (env.storageThrows) throw new Error('blocked'); if (k === PRIVACY_OPT_OUT_KEY) env.stored = v; else if (k === CONSENT_KEY) env.consent = v },
      removeItem: (k: string) => { if (env.storageThrows) throw new Error('blocked'); if (k === PRIVACY_OPT_OUT_KEY) env.stored = null; else if (k === CONSENT_KEY) env.consent = null },
    },
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
// Runs the GA4 inline script for real (OPT_OUT_EXPR interpolated, as the layout does) against a
// stubbed browser, and returns the gtag calls it made, in order.
type Call = unknown[]
function runGaScript(src: string, env: Env): Call[] {
  const body = scriptBody(src, 'google-analytics')
  const code = body.slice(body.indexOf('{`') + 2, body.lastIndexOf('`}')).split('${OPT_OUT_EXPR}').join(OPT_OUT_EXPR)
  const win: { dataLayer?: IArguments[] } = {}
  withEnv(env, () => new Function('window', 'dataLayer', `var dataLayer = window.dataLayer; ${code.replace('window.dataLayer = window.dataLayer || [];', 'window.dataLayer = window.dataLayer || []; dataLayer = window.dataLayer;')}`)(win, undefined))
  return (win.dataLayer ?? []).map(a => Array.from(a))
}
const AD_KEYS = ['ad_storage', 'ad_user_data', 'ad_personalization'] as const
function consentDefault(calls: Call[]) {
  const i = calls.findIndex(c => c[0] === 'consent' && c[1] === 'default')
  const cfg = calls.findIndex(c => c[0] === 'config')
  return { i, cfg, v: (calls[i]?.[2] ?? {}) as Record<string, string> }
}
// The default is always set, before config, with ads = want and analytics granted.
function defaultIs(src: string, env: Env, want: 'denied' | 'granted'): boolean {
  let calls: Call[]
  try { calls = runGaScript(src, env) } catch { return false }
  const { i, cfg, v } = consentDefault(calls)
  return i >= 0 && cfg > i && AD_KEYS.every(k => v[k] === want) && v.analytics_storage === 'granted'
}
const DEFAULT_CASES: [string, Env, 'denied' | 'granted'][] = [
  ['neither', {}, 'granted'],
  ['GPC on', { gpc: true }, 'denied'],
  ['switch on', { stored: '1' }, 'denied'],
  ['storage blocked, no GPC', { storageThrows: true }, 'granted'],
]
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
for (const [name, env, want] of DEFAULT_CASES) {
  check(`Google consent default before config: ${name} -> ads ${want}, analytics granted`, () => ok(defaultIs(layout, env, want), 'wrong, missing or after config'))
}
check('  control: moving the consent default after config is caught', () => {
  const body = scriptBody(layout, 'google-analytics')
  const moved = body.replace(/(\n\s*gtag\('consent', 'default'[^\n]*)([\s\S]*?\n\s*gtag\('config'[^\n]*)/, '$2$1')
  ok(moved !== body && !defaultIs(layout.replace(body, moved), {}, 'granted'), 'not caught')
})
check('  control: the old opted-out-only default is caught (no default for everyone else)', () => {
  const body = scriptBody(layout, 'google-analytics')
  const old = body.replace(/\n\s*var discoAdConsent[^\n]*\n\s*gtag\('consent', 'default'[^\n]*/,
    "\n            if (${OPT_OUT_EXPR}) {\n              gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });\n            }")
  ok(old !== body && !defaultIs(layout.replace(body, old), {}, 'granted'), 'not caught')
})

// The switch: on sends denied; off sends granted unless GPC is on.
function switchUpdates(env: Env, on: boolean, fn: (on: boolean) => void = setSwitchOptedOut): Call[] {
  const calls: Call[] = []
  const g = globalThis as Record<string, unknown>
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'window')
  g.window = { gtag: (...a: unknown[]) => { calls.push(a) }, dispatchEvent: () => true }
  try { withEnv(env, () => fn(on)) } finally { if (prev) Object.defineProperty(globalThis, 'window', prev); else delete g.window }
  return calls.filter(c => c[0] === 'consent' && c[1] === 'update')
}
const updateIs = (calls: Call[], want: string) => calls.length === 1 && AD_KEYS.every(k => (calls[0][2] as Record<string, string>)[k] === want)
check('switch on -> consent update ads denied', () => ok(updateIs(switchUpdates({}, true), 'denied'), 'wrong'))
check('switch on under GPC -> consent update ads denied', () => ok(updateIs(switchUpdates({ gpc: true }, true), 'denied'), 'wrong'))
check('switch off -> consent update ads granted', () => ok(updateIs(switchUpdates({ stored: '1' }, false), 'granted'), 'wrong'))
check('switch off under GPC -> no update (GPC still opts out)', () => ok(switchUpdates({ gpc: true, stored: '1' }, false).length === 0, 'sent an update'))
check('  control: the old switch (no update on switch-off) is caught', () => {
  const oldFn = (on: boolean) => {
    const gtag = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag
    if (on) gtag?.('consent', 'update', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
  }
  ok(!updateIs(switchUpdates({ stored: '1' }, false, oldFn), 'granted'), 'not caught')
})
check('  control: a switch-off that ignores GPC is caught', () => {
  const noGpc = (on: boolean) => {
    const gtag = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag
    const v = on ? 'denied' : 'granted'
    gtag?.('consent', 'update', { ad_storage: v, ad_user_data: v, ad_personalization: v })
  }
  ok(switchUpdates({ gpc: true, stored: '1' }, false, noGpc).length !== 0, 'not caught')
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
