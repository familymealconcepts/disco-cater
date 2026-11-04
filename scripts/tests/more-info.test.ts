// Guards for the "More Info" field (lib/more-info.ts, Peter 2026-11-04).
// Run: npx tsx scripts/tests/more-info.test.ts
//
//   1. Plain text with links only: markup stays text, only http(s) becomes a link.
//   2. The stored value: trimmed, line breaks kept, capped at 2,000.
//   3. Nothing renders it as HTML, and both routes use the same write checks as their neighbours.
import { readFileSync } from 'node:fs'
import { normalizeMoreInfo, moreInfoSegments, MORE_INFO_MAX } from '../../lib/more-info'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg) }
const links = (t: string) => moreInfoSegments(t).filter((s) => s.kind === 'link').map((s) => (s as { href: string }).href)

console.log('\n=== plain text with links only ===')
check('markup is text: <script> and <a href> are not links or elements', () => {
  const t = '<script>alert(1)</script> <a href="https://evil.example">x</a> <img src=x onerror=alert(1)>'
  eq(moreInfoSegments(t).map((s) => s.text).join(''), t, 'round-trip')
  eq(links(t), ['https://evil.example/'], 'only the bare URL inside the quotes-free run')
})
check('javascript:, data: and mailto: never become links', () => {
  eq(links('javascript:alert(1) data:text/html,x mailto:a@b.com'), [], 'no links')
})
check('http, https and www. become links; trailing punctuation stays text', () => {
  eq(links('See www.joes.com. Or (https://joes.com/parking), http://x.org!'), ['https://www.joes.com/', 'https://joes.com/parking', 'http://x.org/'], 'links')
  eq(moreInfoSegments('Park at www.joes.com.').map((s) => s.text), ['Park at ', 'www.joes.com', '.'], 'segments')
})
check('text round-trips exactly, line breaks included', () => {
  const t = 'Line one\nLine two  with spaces\n\nhttps://a.com/x?y=1#z end'
  eq(moreInfoSegments(t).map((s) => s.text).join(''), t, 'join')
})

console.log('\n=== the stored value ===')
check('trimmed, CRLF folded, empty is null, capped at 2,000', () => {
  eq(normalizeMoreInfo('  hi\r\nthere  '), 'hi\nthere', 'trim + CRLF')
  eq(normalizeMoreInfo('   '), null, 'blank')
  eq(normalizeMoreInfo(undefined), null, 'missing')
  eq(normalizeMoreInfo('x'.repeat(5000))?.length, MORE_INFO_MAX, 'cap')
  eq(normalizeMoreInfo('a\u0000b\u0007c\td'), 'abc\td', 'control characters')
})

console.log('\n=== never HTML; same write checks ===')
const ui = readFileSync('app/components/MoreInfo.tsx', 'utf8')
const portalRoute = readFileSync('app/api/restaurant/more-info/route.ts', 'utf8')
const adminRoute = readFileSync('app/api/admin/restaurants/[ref]/more-info/route.ts', 'utf8')
check('the UI never uses dangerouslySetInnerHTML, and links open in a new tab safely', () => {
  ok(!/dangerouslySetInnerHTML/.test(ui.replace(/\/\/.*$/gm, '')), 'dangerouslySetInnerHTML in MoreInfo.tsx')
  ok(/target="_blank" rel="noopener noreferrer/.test(ui), 'links must be target=_blank rel=noopener noreferrer')
})
check('the popup closes on Esc, the close button, and a click outside', () => {
  ok(/e\.key === 'Escape'/.test(ui) && /aria-label="Close"/.test(ui) && /onClick=\{\(\) => setOpen\(false\)\}/.test(ui), 'close paths')
})
check('the portal route uses the disco-settings write check; the admin route is admin-only', () => {
  ok(/requireWritableRestaurantRef\(body\?\.restaurant_reference\)/.test(portalRoute), 'portal write check')
  ok(/getAdminAuthHeader\(\)/.test(adminRoute), 'admin auth')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
