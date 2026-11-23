// Guards for the order label on restaurants' own Stripe payments (Peter, 2026-11-20).
// No network. The Stripe test-mode run is scripts/verify-payment-label-testmode.ts.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { paymentDescription, receiptNumber, transferPurpose } from '../../lib/order/restaurant-payment-label'

let n = 0
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++ }

ok(paymentDescription({ orderNumber: '12345678', customerName: 'Jane Doe', orderReference: null }) === 'Order #12345678 · Jane Doe', 'order number and customer')
ok(paymentDescription({ orderNumber: '900000001', customerName: '  ', orderReference: null }) === 'Order #900000001', 'no dangling separator without a name')
ok(paymentDescription({ orderNumber: '1', customerName: 'A B', orderReference: null }, 'order edit') === 'Order #1 · A B (order edit)', 'an edit payment says so')
ok(receiptNumber('Receipt # 87654321; Total: 10.00 USD;') === '87654321' && receiptNumber('Payment for Invoice') === null, "FamilyMeal's receipt number")
ok(transferPurpose({ kind: 'native_edit_payout' }) === 'order edit' && transferPurpose({ kind: 'native_invoice_payout' }) === null && transferPurpose(null) === null, 'only extra payments get a purpose')

// Labels describe money; they never move it.
const lib = readFileSync('lib/order/restaurant-payment-label.ts', 'utf8')
ok(!/transfers\.create|createReversal|refunds\.create|payouts\.create|paymentIntents\.(create|capture)/.test(lib), 'no money-moving Stripe call in the label code')
ok(/charges\.update\(paymentId, \{ description, metadata \}/.test(lib), 'the only write is description + metadata')
ok(/labelTransferPaymentForEvent\(stripe, event\)/.test(readFileSync('app/api/stripe/webhook/route.ts', 'utf8')), 'the webhook labels each new transfer')

console.log(`restaurant-payment-label: ${n} checks passed`)
