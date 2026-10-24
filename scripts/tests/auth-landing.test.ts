// Guards for where a diner lands after a header log-in or sign-up (lib/utils/auth-landing.ts; Kevin, item #36, 2026-10-23).
// Run: npx tsx scripts/tests/auth-landing.test.ts
import { readFileSync } from 'node:fs'
import { STAY_PUT_PREFIXES, staysPutAfterAuth } from '../../lib/utils/auth-landing'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg) }

check('a diner stays put on the four browsing pages, including the 1P links pages', () => {
  eq([...STAY_PUT_PREFIXES], ['/restaurants/', '/order/', '/fullmap', '/locations/'], 'the list')
  for (const p of ['/restaurants/x', '/order/x', '/fullmap', '/fullmap?city=nyc', '/locations/brand']) ok(staysPutAfterAuth(p), `${p} stays put`)
})
check('everywhere else (and no pathname) still goes to the account area, as FM does', () => {
  for (const p of ['/', '/account/orders', '/become-a-partner', '/order-confirmation/abc', '/compare', null, undefined, '']) ok(!staysPutAfterAuth(p as string | null), `${p} goes to the account`)
})
check('both AuthModal handlers use the one list, and no hand-written path check is left', () => {
  const src = readFileSync(new URL('../../app/components/AuthModal.tsx', import.meta.url), 'utf8')
  eq((src.match(/staysPutAfterAuth\(pathname\)/g) ?? []).length, 2, 'sign-up and log-in both call it')
  ok(!/pathname\?\.startsWith\(/.test(src), 'no pathname?.startsWith( left in AuthModal')
})

console.log(`\nauth-landing: ${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
