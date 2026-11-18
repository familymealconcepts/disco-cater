// Guards for the courier tracking link in diner and restaurant emails (lib/order/delivery-tracking.ts).
// Run: npx tsx scripts/tests/delivery-tracking.test.ts
//
//   1. The link is read from Expedite's booking response (data.result_tracking_link), https only.
//   2. Third-party (Expedite) delivery only: pickup and self-delivery never get a link.
//   3. All nine emails print "Track your delivery here" when given a link, and nothing without one.
//   4. The confirmation waits for the courier booking, but never more than the cap, and never on a failure.
//   5. Both booking paths book first, then confirm; the booking saves the link on the order.
// Emails are rendered with fetch stubbed, so nothing is sent.
import { readFileSync } from 'node:fs'
import { bookCourierThenConfirm, cleanTrackingUrl, trackingUrlFor, trackingUrlFromExpediteResponse } from '../../lib/order/delivery-tracking'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const URL = 'https://track.expedite.io/tracking/2382ab01ea3997a7656a7005e35a87c840507abb73906f4efb50b80f66'

// Capture what would go to Mailgun instead of sending it.
process.env.MAILGUN_API_KEY = 'test-key'
process.env.MAILGUN_DOMAIN = 'mg.test.invalid'
const sent: { subject: string; html: string }[] = []
globalThis.fetch = (async (_u: unknown, init?: { body?: FormData }) => {
  const f = init?.body
  sent.push({ subject: String(f?.get('subject') ?? ''), html: String(f?.get('html') ?? '') })
  return new Response(JSON.stringify({ id: '<test>' }), { status: 200 })
}) as typeof fetch

async function main() {
  console.log('\n=== Delivery tracking link ===')
  await check("read from Expedite's booking response, https only", () => {
    // The shape #900001507's booking returned (trimmed).
    eq(trackingUrlFromExpediteResponse({ status: 'success', data: { external_delivery_id: 'x', result_tracking_link: URL, delivery_fee: 43 } }), URL, 'data.result_tracking_link')
    eq(trackingUrlFromExpediteResponse({ status: 'success', data: { result_tracking_link: null } }), null, 'no link')
    eq(trackingUrlFromExpediteResponse(undefined), null, 'no body')
    eq(cleanTrackingUrl('http://track.expedite.io/x'), null, 'http refused')
    eq(cleanTrackingUrl('javascript:alert(1)'), null, 'script refused')
  })
  await check('third-party delivery only', () => {
    eq(trackingUrlFor({ delivery_type: 'THIRD_PARTY_DELIVERY', expedite_tracking_url: URL }), URL, 'Expedite delivery')
    eq(trackingUrlFor({ delivery_type: 'OWN_DELIVERY', expedite_tracking_url: URL }), undefined, 'self-delivery')
    eq(trackingUrlFor({ delivery_type: null, expedite_tracking_url: URL }), undefined, 'pickup')
    eq(trackingUrlFor({ delivery_type: 'THIRD_PARTY_DELIVERY', expedite_tracking_url: null }), undefined, 'no link yet')
  })

  const n = await import('../../lib/email/notifications')
  const base = {
    firstName: 'LaNette', lastName: 'Searcy', orderService: 'Third-Party Delivery', orderType: 'DELIVERY', orderDate: 'Wednesday, November 18, 2026', orderTime: '8:45 AM',
    orderReceived: 'Nov 16, 2026, 11:03 PM', orderMealPackages: [{ name: 'Dozen Assorted Bagels', count: 1, price: 32 }], subtotal: 154, totalPrice: 210.79,
    orderNumber: '900001507', businessName: 'Apollo Bagels - Industry City',
  } as Parameters<typeof n.sendCustomerOrderConfirmation>[0]
  const items = [{ name: 'Dozen Assorted Bagels', count: 1, price: 32 }]
  const nine: [string, (url?: string) => Promise<unknown>, string][] = [
    ['confirmation', (u) => n.sendCustomerOrderConfirmation({ ...base, to: 'd@x.test', deliveryTrackingUrl: u }), 'Track your delivery'],
    ['restaurant confirmation', (u) => n.sendRestaurantOrderNotification({ ...base, restaurantEmail: 'r@x.test', deliveryType: 'THIRD_PARTY_DELIVERY', deliveryTrackingUrl: u }), 'Track this delivery'],
    ['reminder', (u) => n.sendCustomerOrderReminder({ ...base, to: 'd@x.test', deliveryTrackingUrl: u }), 'Track your delivery'],
    ['restaurant reminder', (u) => n.sendRestaurantOrderReminder({ ...base, to: 'r@x.test', deliveryTrackingUrl: u }), 'Track this delivery'],
    ['order updated', (u) => n.sendOrderUpdated({ to: 'd@x.test', orderNumber: 1, businessName: 'B', items, newTotal: 10, delta: 0, deliveryTrackingUrl: u }), 'Track your delivery'],
    ['restaurant order updated / date-time change', (u) => n.sendOrderUpdatedRestaurant({ to: 'r@x.test', orderNumber: 1, businessName: 'B', items, newTotal: 10, delta: 0, deliveryTrackingUrl: u }), 'Track this delivery'],
    ['edit payment confirmed', (u) => n.sendOrderEditPaymentConfirmed({ to: 'd@x.test', orderNumber: 1, businessName: 'B', deliveryTrackingUrl: u }), 'Track your delivery'],
    ['invoice reminder', (u) => n.sendCustomerInvoiceReminder({ to: 'd@x.test', orderNumber: 1, businessName: 'B', amountDue: 10, deliveryTrackingUrl: u }), 'Track your delivery'],
    ['restaurant invoice paid', (u) => n.sendRestaurantInvoicePaid({ to: 'r@x.test', orderNumber: 1, total: 10, deliveryTrackingUrl: u }), 'Track this delivery'],
  ]
  for (const [name, send, words] of nine) {
    await check(`${name}: the link when there is one, nothing when there isn't`, async () => {
      sent.length = 0
      await send(URL)
      const withLink = sent[0]?.html ?? ''
      if (!withLink.includes(`${words} <a href="${URL}"`) || !withLink.includes('>here</a>.')) throw new Error('no tracking line')
      sent.length = 0
      await send(undefined)
      const without = sent[0]?.html ?? ''
      if (!without || /Track (your|this) delivery|track\.expedite/i.test(without)) throw new Error('tracking line without a link')
    })
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  await check('confirmation goes out after the booking', async () => {
    const order: string[] = []
    await bookCourierThenConfirm(async () => { await sleep(20); order.push('booked') }, async () => { order.push('confirmed') }, 1000)
    eq(order, ['booked', 'confirmed'], 'order')
  })
  await check('a slow booking never holds the confirmation past the cap', async () => {
    const order: string[] = []
    const t = Date.now()
    await bookCourierThenConfirm(async () => { await sleep(300); order.push('booked') }, async () => { order.push('confirmed') }, 50)
    if (Date.now() - t > 200) throw new Error('waited past the cap')
    eq(order, ['confirmed'], 'confirmed first')
    await sleep(300)
    eq(order, ['confirmed', 'booked'], 'booking still finished')
  })
  await check('a failed booking sends the confirmation at once', async () => {
    const order: string[] = []
    const t = Date.now()
    await bookCourierThenConfirm(async () => { throw new Error('expedite 500') }, async () => { order.push('confirmed') }, 5000)
    if (Date.now() - t > 200) throw new Error('waited on a failure')
    eq(order, ['confirmed'], 'confirmed')
  })
  await check('no courier (dispatch off): straight to the confirmation', async () => {
    const order: string[] = []
    await bookCourierThenConfirm(null, async () => { order.push('confirmed') })
    eq(order, ['confirmed'], 'confirmed')
  })
  await check('both booking paths book first, and the booking saves the link', () => {
    for (const f of ['lib/order/native-payment-succeeded.ts', 'app/api/restaurant/orders/place/route.ts']) {
      const src = readFileSync(f, 'utf8')
      if (!/bookCourierThenConfirm\(\s*nativeDispatchEnabled\(\) \? \(\) => dispatchExpediteForOrder\(/.test(src)) throw new Error(`${f}: not booking first`)
      if (/waitUntil\(dispatchOrderConfirmations\(|waitUntil\(dispatchExpediteForOrder\(/.test(src)) throw new Error(`${f}: still sends separately`)
    }
    const ex = readFileSync('lib/expedite.ts', 'utf8')
    if (!ex.includes('expedite_tracking_url = COALESCE(${result.trackingUrl ?? null}, expedite_tracking_url)')) throw new Error('booking does not save the link')
    if (!readFileSync('lib/migrations/001_disco_orders.sql', 'utf8').includes('ADD COLUMN IF NOT EXISTS expedite_tracking_url TEXT')) throw new Error('no column')
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main()
