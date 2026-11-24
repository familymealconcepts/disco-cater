// Guards for Export Orders (lib/order/order-export.ts, app/api/restaurant/orders/export).
// Run: npx tsx scripts/tests/order-export.test.ts
//
//   1. FamilyMeal's labels: the fmTypes pipe, its status names, its date and Items-cell text, its eight columns.
//   2. The two FamilyMeal bugs stay fixed: the file name's month, and "Received on" is when the order was placed.
//   3. Names print "Bob Mulry", never FamilyMeal's "Bob-Mulry".
//   4. Special instructions print in both PDFs: each item's under it, the order note, delivery instructions.
//   5. The export reads the Orders list through the list route itself (same scope, permissions and filters)
//      without starting a FamilyMeal sync per page; the button is on Active and History.
import { readFileSync } from 'node:fs'
import { XLSX_COLUMNS, exportFileName, summaryRange, summaryRestaurant, fmType, itemsCell, longDate, receivedOn, statusLabel, xlsxRow, type ExportOrder } from '../../lib/order/order-export'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const order = (o: Partial<ExportOrder> = {}): ExportOrder => ({
  pdf: { orderNumber: '43997813', customerEmail: 'bob@example.com', items: [{ name: 'BBQ Sampler for 4', quantity: 1, price: 80, addOns: [{ name: 'Large French Fries', price: 5, quantity: 2 }] }, { name: 'Burger Package', quantity: 2, price: 20 }], total: 87.97 } as ExportOrder['pdf'],
  firstName: 'Bob', lastName: 'Mulry', orderStatus: 'DUE', orderType: 'PICKUP', deliveryType: null, orderDate: '2026-11-25', orderTime: '10:00:00',
  dropOffTime: null, placedAt: '2026-11-11T03:02:12.000Z', timezone: 'America/New_York', purchaseType: null, serviceChargeName: null, ...o,
})

console.log('\n=== Export Orders ===')
check("FamilyMeal's type and status labels", () => {
  eq(['OWN_DELIVERY', 'NASH_DELIVERY', 'DOOR_DASH_DELIVERY', 'MEAL_PACKAGES', 'CLASSICS_MEAL_PACKAGES', 'SUBSCRIPTION'].map(fmType), ['Self-Delivery', 'Third-Party Delivery', 'Third-Party Delivery', 'Items', 'Items, Modifiers', 'Subscription'], 'fmTypes')
  eq(['DUE', 'REOPEN', 'CANCELED', 'CANCELLED', 'VOIDED', 'PARTIAL_REFUND'].map(statusLabel), ['Due', 'Reopened', 'Canceled', 'Canceled', 'Voided', 'Partial refunded'], 'statuses')
})
check("FamilyMeal's date, Items cell and columns", () => {
  eq(longDate('2026-11-05'), 'Thursday, November 05, 2026', "'dddd, MMMM DD, YYYY'")
  eq(itemsCell(order().pdf.items), 'BBQ Sampler for 4 - 1 ( Large French Fries- 2, ), Burger Package - 2', 'items')
  eq([...XLSX_COLUMNS], ['Name', 'Email', 'Order', 'Prepare by', 'Drop off time', 'Service', 'Items', 'Type', 'Total', 'Status'], 'columns')
})
check('the XLSX row: name without a hyphen, received when placed, prepare-by time then date', () => {
  const r = xlsxRow(order())
  eq(r.slice(0, 2), ['Bob Mulry', 'bob@example.com'], 'Name and Email lead')
  eq(r[2], 'Bob Mulry\nOrder ID: 43997813\nReceived on 11/10/26 at 10:02 PM EST', 'Order cell (restaurant zone, with its abbreviation)')
  eq(r.slice(3), ['10:00 AM\n11/25/26', '', 'Pickup', 'BBQ Sampler for 4 - 1 ( Large French Fries- 2, ), Burger Package - 2', 'Items', 87.97, 'Due'], 'rest')
  eq(xlsxRow(order({ orderType: 'DELIVERY', deliveryType: 'OWN_DELIVERY' }))[5], 'Self-Delivery', 'delivery service')
  eq(receivedOn(null, 'America/New_York'), '', 'no time, no text')
  // The same instant in Central and Pacific restaurants, and Eastern when none is saved (Peter, 2026-11-24).
  eq(receivedOn('2026-11-24T17:15:00Z', 'America/Chicago'), 'Received on 11/24/26 at 11:15 AM CST', 'Central')
  eq(receivedOn('2026-11-24T17:15:00Z', 'America/Los_Angeles'), 'Received on 11/24/26 at 9:15 AM PST', 'Pacific')
  eq(receivedOn('2026-11-24T17:15:00Z', ''), 'Received on 11/24/26 at 12:15 PM EST', 'no zone saved: Eastern')
})
check('file names: the right month, FamilyMeal shapes', () => {
  const f = { fromDate: '2026-11-25', toDate: '2026-11-25', desc: true, today: '2026-11-17' }
  eq(exportFileName('XLSX', [order()], f), 'OrderSummary_11172026.xlsx', 'xlsx (FamilyMeal printed 10172026)')
  eq(exportFileName('DETAILS', [order()], f), 'OrderDetails_112526-112526.pdf', 'details')
  eq(exportFileName('DETAILS', [order()], { ...f, fromDate: undefined }), 'OrderDetails.pdf', 'details, no range')
  eq(exportFileName('SUMMARY', [order({ orderDate: '2026-11-24' }), order()], f), 'OrderSummary_11252026-11242026.pdf', 'summary, newest first')
  eq(exportFileName('SUMMARY', [order({ orderDate: '2026-11-24' }), order()], { ...f, desc: false }), 'OrderSummary_11242026-11252026.pdf', 'summary, oldest first')
})
check('the summary never hyphenates the name and opens to print', () => {
  const lib = readFileSync('lib/order/order-export.ts', 'utf8')
  if (/firstName\s*\+\s*'-'/.test(lib)) throw new Error('hyphenated name')
  if (!/N: 'Print'/.test(lib)) throw new Error('no print-on-open')
})
check('summary branding: logo header with restaurant and date range, footer with page numbers', () => {
  eq(summaryRange([order({ orderDate: '2026-11-24' }), order()]), 'Date range: 11/24/2026 - 11/25/2026', 'range from the orders')
  eq(summaryRange([order()], '2026-11-20', '2026-11-30'), 'Date range: 11/20/2026 - 11/30/2026', 'range from the filter')
  const one = order(); one.pdf = { ...one.pdf, restaurantName: 'Westwoods' }
  const two = order(); two.pdf = { ...two.pdf, restaurantName: 'Other' }
  eq(summaryRestaurant([one, one]), 'Westwoods', 'one restaurant')
  eq(summaryRestaurant([one, two]), '2 locations', 'all locations')
  const lib = readFileSync('lib/order/order-export.ts', 'utf8')
  if (!lib.includes('Disco Cater · discocater.com · Page ${i + 1} of ${pages.length}') || !lib.includes('DISCO_LOGO_PNG_BASE64')) throw new Error('header/footer')
  if (!/const newPage = \(\) => \{ page = doc\.addPage\(TABLOID\); header\(page\)/.test(lib)) throw new Error('header on every page')
})
check('special instructions in both PDFs: item notes under the item, the order note, delivery instructions, wrapped', () => {
  const lib = readFileSync('lib/order/order-export.ts', 'utf8')
  if (!/if \(it\.note\) push\(\{ value: wrap\(it\.note,/.test(lib)) throw new Error('summary: item note under its item')
  if (!lib.includes("labelled('NOTE:', d.note)") || !lib.includes("labelled('DELIVERY INSTRUCTIONS:', d.deliveryInstructions)")) throw new Error('summary: order note and delivery instructions')
  if (!/push\(\{ label, lx: 175, value: wrap\(value, vx, 650\), vx \}\)/.test(lib)) throw new Error('summary: wrapped, never cut')
  const pdf = readFileSync('lib/order/order-pdf.ts', 'utf8')
  for (const s of ["if (d.note) fullBox([labelLine('Note:')", "if (d.deliveryInstructions) fullBox([labelLine('Delivery Instructions:')", "if (it.note) sub(it.note"])
    if (!pdf.includes(s)) throw new Error(`details: ${s}`)
})
check('the route reads the list through the list route, without a sync per page', () => {
  const route = readFileSync('app/api/restaurant/orders/export/route.ts', 'utf8')
  const list = readFileSync('app/api/restaurant/orders/route.ts', 'utf8')
  if (!route.includes("import { GET as listOrders } from '../route'") || !route.includes("q.set('noSync', '1')")) throw new Error('route')
  if (!list.includes("sp.get('noSync') !== '1'")) throw new Error('list route ignores noSync')
})
check('the button is on Active and History', () => {
  const page = readFileSync('app/(restaurant)/restaurant/(portal)/orders/page.tsx', 'utf8')
  const i = page.indexOf('Export Orders\n            </button>')
  if (i < 0) throw new Error('no button')
  // It sits in the filter bar shared by both tabs, not inside a tab === 'active' block.
  const before = page.slice(page.lastIndexOf('{/* Filter Bar */}', i), i)
  if (/\{tab === 'active' && \(\s*<button onClick=\{\(\) => setExportOpen/.test(before)) throw new Error('Active only')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
