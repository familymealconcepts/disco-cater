// Guards for the message shown when placing an order is refused (lib/place-refusal-message.ts).
// Run: npx tsx scripts/tests/place-refusal-message.test.ts
//
//   1. FamilyMeal's refusal reason (`description`) reaches the customer instead of "error 409".
//   2. Disco's own `error` / `message` still win; the status fallbacks are unchanged.
//   3. Checkout uses the helper rather than an inline copy that could drop `description` again.
import { readFileSync } from 'node:fs'
import { placeRefusalMessage } from '../../lib/place-refusal-message'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

console.log('\n=== place refusal message ===')
check("FamilyMeal's description is shown", () => {
  const fm = { code: '409-045', description: "This date isn't available. Please choose another date.", httpResponseCode: 409, label: 'ORDER_DATE_IS_NOT_AVAILABLE' }
  eq(placeRefusalMessage(409, fm), "This date isn't available. Please choose another date.", 'FM 409')
})
check('Disco error wins over description; message next', () => {
  eq(placeRefusalMessage(401, { error: 'Please log in to place your order', description: 'x' }), 'Please log in to place your order', 'error first')
  eq(placeRefusalMessage(400, { message: 'm', description: 'd' }), 'm', 'message before description')
})
check('fallbacks unchanged when the body says nothing', () => {
  eq(placeRefusalMessage(403, {}), 'Please sign in again to place your order.', '403')
  eq(placeRefusalMessage(502, null), 'We could not place your order (error 502). Please try again.', '502')
  eq(placeRefusalMessage(409, { description: '   ' }), 'We could not place your order (error 409). Please try again.', 'blank description')
})
check('CheckoutDrawer surfaces refusals through the helper', () => {
  const src = readFileSync('app/(customer)/restaurants/[slug]/CheckoutDrawer.tsx', 'utf8')
  if (!src.includes('placeRefusalMessage(placeRes.status, placeData)')) throw new Error('CheckoutDrawer no longer uses placeRefusalMessage for a refused place')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
