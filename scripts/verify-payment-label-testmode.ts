// Stripe TEST MODE check for lib/order/restaurant-payment-label.ts: a destination charge's payment in the
// restaurant's account gets "Order #N · Customer" + metadata; a second run changes nothing; a transfer
// that names no order is left alone. Reads one real order from Neon (read only) to label with.
//   npx tsx scripts/verify-payment-label-testmode.ts <acct_test_connected_account> <order_reference>
import { config } from 'dotenv'; config({ path: '.env.local', quiet: true } as never)
import Stripe from 'stripe'
import { strict as assert } from 'node:assert'

const ACCT = process.argv[2] || 'acct_1Toa9bKmFeY8kpjq'
const ORDER = process.argv[3] || ''

async function transferOf(stripe: Stripe, chargeId: string): Promise<Stripe.Transfer> {
  for (let i = 0; i < 20; i++) {
    const c = await stripe.charges.retrieve(chargeId)
    if (c.transfer) return stripe.transfers.retrieve(typeof c.transfer === 'string' ? c.transfer : c.transfer.id)
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('no transfer attached')
}

async function main() {
  const key = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY || ''
  if (!key.startsWith('sk_test_')) throw new Error('needs a Stripe TEST key')
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' } as never)
  const { labelTransferPayment, orderForReference } = await import('../lib/order/restaurant-payment-label')
  const expected = await orderForReference(ORDER)
  assert.ok(ORDER && expected, 'pass an order reference that exists in Neon')

  const pi = await stripe.paymentIntents.create({
    amount: 2400, currency: 'usd', payment_method: 'pm_card_visa', confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    transfer_data: { destination: ACCT, amount: 2000 }, metadata: { orderReference: ORDER, kind: 'label-test' },
  })
  const t = await transferOf(stripe, String(pi.latest_charge))
  const first = await labelTransferPayment(stripe, t)
  assert.equal(first.outcome, 'labelled')
  const py = await stripe.charges.retrieve(String(t.destination_payment), {}, { stripeAccount: ACCT })
  assert.equal(py.description, `Order #${expected!.orderNumber} · ${expected!.customerName}`)
  assert.equal(py.metadata.order_number, expected!.orderNumber)
  assert.equal(py.metadata.customer_name, expected!.customerName)
  console.log('labelled', py.id, '→', py.description)
  assert.equal((await labelTransferPayment(stripe, t)).outcome, 'unchanged', 'a second run writes nothing')

  const manual = await stripe.transfers.create({ amount: 100, currency: 'usd', destination: ACCT })
  assert.equal((await labelTransferPayment(stripe, manual)).outcome, 'no-order', 'a transfer naming no order is left alone')
  const bare = await stripe.charges.retrieve(String(manual.destination_payment), {}, { stripeAccount: ACCT })
  assert.ok(!bare.description && !bare.metadata.order_number, 'and nothing was written on it')
  console.log('ok: labelled, idempotent, unlinked transfer untouched')
}
main().then(() => process.exit(0)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
