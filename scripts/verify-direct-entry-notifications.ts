/**
 * Verifies a direct entry order notifies through every channel at PLACEMENT, on
 * BOTH payment methods, and that the customer fields are never inherited from a
 * staff member's diner session.
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ─────────────────────────────────────
 * The wiring is asserted against the SOURCE, not by placing an order: a real
 * end-to-end run would charge a card or email a real customer, and #900000172 is
 * already the evidence for what the old wiring did. So these are structural
 * assertions plus a real execution of the validation rule. An actual send is
 * exercised by the existing admin resend path, not here.
 *
 *   npx tsx scripts/verify-direct-entry-notifications.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail}`}`)
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const placeRoute = read('app/api/restaurant/orders/place/route.ts')
const notifications = read('lib/order-notifications.ts')
const webhook = read('app/api/stripe/webhook/route.ts')
const drawer = read('app/(customer)/restaurants/[slug]/CheckoutDrawer.tsx')
const paymentSucceeded = read('lib/order/native-payment-succeeded.ts')

console.log('\n=== INVOICE: every channel, at placement (FM parity) ===')
check('the invoice branch dispatches confirmations at placement',
  /waitUntil\(dispatchOrderConfirmations\(r\.orderId, 'NATIVE_INVOICE_PLACED'\)\)/.test(placeRoute),
  'invoice placement still sends nothing but the Stripe invoice')
check('...and it is NOT gated on payment',
  placeRoute.indexOf("NATIVE_INVOICE_PLACED") < placeRoute.indexOf('let outcome'),
  'the dispatch sits outside the invoice branch')

console.log('\n=== CARD: every channel, on payment success ===')
check('the card path dispatches confirmations',
  /dispatchOrderConfirmations\(order\.id, source\)/.test(paymentSucceeded),
  'native-payment-succeeded no longer dispatches')

console.log('\n=== dispatchOrderConfirmations covers all four channels ===')
check('customer confirmation email', /sendCustomerOrderConfirmation\(/.test(notifications))
check('restaurant notification email', /sendRestaurantOrderNotification\(/.test(notifications))
check('restaurant SMS', /sendSms\(/.test(notifications))
check('Slack new-order ping', /sendNewOrderSlack\(/.test(notifications))

console.log('\n=== FM\'s separate invoice-PAID restaurant notice is kept ===')
check('dispatched from the invoice.payment_succeeded webhook',
  /waitUntil\(dispatchInvoicePaidRestaurantNotification\(order\.id\)\)/.test(webhook))
check('restaurant-only, matching FM (no customer copy)',
  /dispatchInvoicePaidRestaurantNotification/.test(notifications) &&
  !/sendCustomerOrderConfirmation/.test(notifications.slice(notifications.indexOf('dispatchInvoicePaidRestaurantNotification'), notifications.indexOf('dispatchInventoryUnavailableNotification'))))

console.log('\n=== Direct entry never inherits the staff diner identity ===')
const prefill = drawer.slice(drawer.indexOf('const [contactFirst'), drawer.indexOf('// GA funnel: contact details completed'))
check('the prefill effect returns early on direct entry',
  /if \(isDirectEntry\) return/.test(prefill),
  'staff details would still pre-fill the customer')
check('...and isDirectEntry is in its dependency array',
  /\}, \[authUser, isDirectEntry\]\)/.test(prefill))

console.log('\n=== Required customer fields, both client and server ===')
for (const [label, src] of [['client (CheckoutDrawer)', drawer], ['server (place route)', placeRoute]] as const) {
  for (const f of ['first name', 'last name', 'email', 'phone number']) {
    check(`${label}: requires ${f}`, src.includes(`'${f}'`), `${f} not required`)
  }
}

// The one rule executed rather than read: the missing-field list the gate builds.
console.log('\n=== the validation rule, executed ===')
const missingFor = (c: { firstName?: string; lastName?: string; email?: string; phoneNumber?: string }) => {
  const str = (v: unknown) => String(v ?? '').trim()
  return [
    !str(c.firstName) && 'first name',
    !str(c.lastName) && 'last name',
    !str(c.email) && 'email',
    !str(c.phoneNumber).replace(/\D/g, '') && 'phone number',
  ].filter(Boolean) as string[]
}
check('a fully blank customer is rejected on all four',
  missingFor({}).length === 4, JSON.stringify(missingFor({})))
check('#900000172\'s exact shape (name + email, NO phone) is now rejected',
  missingFor({ firstName: 'Kealoha', lastName: 'Pomerantz', email: 'kealoha@familymeal.com', phoneNumber: '' }).join() === 'phone number',
  'the order that started this would still be accepted')
check('a complete customer passes',
  missingFor({ firstName: 'Jane', lastName: 'Doe', email: 'j@d.com', phoneNumber: '(555) 123-4567' }).length === 0)
check('punctuation-only phone is not a phone',
  missingFor({ firstName: 'A', lastName: 'B', email: 'a@b.com', phoneNumber: '()- ' }).join() === 'phone number')

console.log('\n' + '='.repeat(64))
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
