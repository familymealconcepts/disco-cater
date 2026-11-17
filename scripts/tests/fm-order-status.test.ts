// Guards for a portal status change on a FamilyMeal-processed order (lib/order/fm-order-status.ts).
// Run: npx tsx scripts/tests/fm-order-status.test.ts
//
//   1. FamilyMeal goes FIRST and is not optional: the route returns FamilyMeal's refusal and never reaches
//      the Disco write (#43997813: a "best-effort" call failed silently, Disco said Cancelled, the sync undid it).
//   2. The call is FamilyMeal's super-admin status change scoped to the order's restaurant, once (no retry),
//      never the restaurant endpoint the service account cannot use, and never a refund.
//   3. The refusal is a sentence the restaurant can act on; Disco's spellings map to FamilyMeal's enum.
//   4. The list's status dropdown shows a refusal instead of ignoring the reply.
import { readFileSync } from 'node:fs'
import { fmRefusalMessage, fmStatusFor } from '../../lib/order/fm-order-status'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function ok(c: boolean, msg: string) { if (!c) throw new Error(msg) }

const route = readFileSync('app/api/restaurant/orders/[ref]/status/route.ts', 'utf8')
const lib = readFileSync('lib/order/fm-order-status.ts', 'utf8')
const page = readFileSync('app/(restaurant)/restaurant/(portal)/orders/page.tsx', 'utf8')

console.log('\n=== FamilyMeal order status ===')
check('the route changes FamilyMeal before Disco and stops on a refusal', () => {
  const fm = route.indexOf('await setFamilyMealOrderStatus(ref, status)')
  const stop = route.indexOf('if (!fm.ok) return NextResponse.json({ error: fm.error }, { status: fm.status })')
  const disco = route.indexOf('await applyNativeStatusChange(')
  ok(fm > 0 && stop > fm && disco > stop, 'order must be FamilyMeal, refusal return, then the Disco write')
  ok(!/updateStatus\?orderStatus|non-fatal/.test(route), 'the old best-effort proxy is gone')
})
check("FamilyMeal's super-admin change, scoped, one attempt, no refund", () => {
  ok(lib.includes('/api/admin/userOrders/${o.fm}?restaurantReference=${o.rr}'), 'super-admin endpoint scoped by restaurant')
  ok(/method: 'PUT'[^\n]*AbortSignal\.timeout/.test(lib) && !/fmFetch\(`\$\{url\}&orderStatus/.test(lib), 'the PUT is a single fetch, not the retrying fmFetch')
  ok(!/\/refund/i.test(lib), 'no refund endpoint is ever called')
})
check('Disco spellings map to FamilyMeal', () => {
  ok(fmStatusFor('CANCELLED') === 'CANCELED' && fmStatusFor('CANCELED') === 'CANCELED' && fmStatusFor('VOIDED') === 'VOID' && fmStatusFor('COMPLETED') === 'COMPLETED', 'mapping')
})
check('the refusal says what happened and what to do', () => {
  const m = fmRefusalMessage('CANCELED', 'REOPEN', 'STATUS_CHANGE_NOT_ALLOWED')
  ok(m.includes("won't change it from Reopened to Cancelled") && m.includes('nothing was changed') && m.includes('Set it to Due first'), m)
  ok(fmRefusalMessage('COMPLETED', 'CANCELED', 'STATUS_CHANGE_NOT_ALLOWED').includes('from Cancelled to Completed'), 'names both statuses')
  ok(fmRefusalMessage('CANCELED', null, null).includes('nothing was changed'), 'unknown failure still says nothing changed')
})
check("the list's dropdown shows a refusal", () => {
  ok(page.includes('async function putListStatus(') && page.includes('putListStatus(order.orderReference, newStatus)'), 'helper used')
  ok(!/fetch\(`\/api\/restaurant\/orders\/\$\{order\.orderReference\}\/status/.test(page), 'no fire-and-forget status fetch left in the list')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
