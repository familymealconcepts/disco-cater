// Stripe TEST MODE check that Hold Payments holds the restaurant's share on every Disco payment path
// (Peter, 2026-11-10). Runs the production builders from lib/order/native-payment.ts against test mode:
// card checkout, saved-card / recurring off-session charges, pay by invoice / direct entry, order-edit card
// deltas, edit and reissue invoices (the paid-invoice webhook's payout decision), and a refund of a held
// charge. A held charge must still be on the restaurant's behalf, with the same statement name as a normal
// one (Peter, 2026-11-10: held orders look exactly like normal orders). Each held case is paired with a not-held control that must still pay out. Stripe only: no
// database writes. Refuses to run with anything but an sk_test_ key.
//   npx tsx scripts/verify-native-hold-testmode.ts [acct_test_connected_account]
import { config } from 'dotenv'; config({ path: '.env.local', quiet: true } as never)
import Stripe from 'stripe'
import { STRIPE_API_VERSION, createNativeOrderPaymentIntent, invoiceNeedsManualPayout, nativeInvoiceRouting, payoutHoldFrom } from '../lib/order/native-payment'

const key = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY || ''
if (!key.startsWith('sk_test_')) { console.error('Refusing: no Stripe test key (STRIPE_TEST_SECRET_KEY).'); process.exit(1) }
const s = new Stripe(key, { apiVersion: STRIPE_API_VERSION } as never)
const ACCT = process.argv[2] || 'acct_1Toa9bKmFeY8kpjq'
let failures = 0
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const held = { connectedAccountId: ACCT, withholdPayouts: true }
const open = { connectedAccountId: ACCT, withholdPayouts: false }
const TOTAL = 214.73, TRANSFER = 180.12

/** The charge, waiting for a destination charge's transfer to attach (it lands moments after success). */
async function chargeOf(pi: Stripe.PaymentIntent, expectTransfer = false) {
  let ch = await s.charges.retrieve(pi.latest_charge as string)
  for (let i = 0; expectTransfer && !ch.transfer && i < 20; i++) { await sleep(1000); ch = await s.charges.retrieve(ch.id) }
  return ch
}

async function cardPath(label: string, extra: Partial<Parameters<typeof createNativeOrderPaymentIntent>[1]>) {
  let heldDescriptor: string | null = null
  for (const [name, pay] of [['held', held], ['not held', open]] as const) {
    const pi = await createNativeOrderPaymentIntent(s, {
      totalDollars: TOTAL, transferDollars: TRANSFER, ...pay, onBehalfOf: true,
      paymentMethodId: 'pm_card_visa', confirm: true,
      metadata: { orderReference: `test-hold-${Date.now()}`, orderNumber: '0', kind: 'native_order' }, ...extra,
    })
    const ch = await chargeOf(pi, name !== 'held')
    if (name === 'held') {
      check(pi.status === 'succeeded' && ch.amount === Math.round(TOTAL * 100), `${label}, held: the full $${TOTAL} is charged`)
      await sleep(5000)
      const later = await s.charges.retrieve(ch.id)
      check(!later.transfer && !pi.transfer_data, `${label}, held: nothing goes to the restaurant (no transfer after 5s)`)
      check(pi.on_behalf_of === ACCT && later.on_behalf_of === ACCT, `${label}, held: still charged on the restaurant's behalf`)
      heldDescriptor = later.calculated_statement_descriptor ?? null
      check(pi.metadata.payoutHeld === '1' && pi.metadata.restaurantPayoutAmount === TRANSFER.toFixed(2), `${label}, held: recorded as held with the $${TRANSFER} owed`)
    } else {
      const t = ch.transfer ? await s.transfers.retrieve(ch.transfer as string) : null
      check(!!t && t.destination === ACCT && t.amount === Math.round(TRANSFER * 100), `${label}, not held: $${TRANSFER} still goes to the restaurant`)
      check(!!ch.calculated_statement_descriptor && ch.calculated_statement_descriptor === heldDescriptor, `${label}: the statement name is the same held or not ("${ch.calculated_statement_descriptor}")`)
    }
    await sleep(300)
  }
}

async function invoicePath(label: string, kind: string, routed: boolean) {
  const cust = await s.customers.create({ email: 'hold-test@example.com', payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: undefined } })
  const pm = await s.paymentMethods.attach('pm_card_visa', { customer: cust.id })
  for (const [name, pay] of [['held', held], ['not held', open]] as const) {
    const r = routed ? nativeInvoiceRouting(pay, TRANSFER) : { routeToRestaurant: false, params: {} }
    const inv = await s.invoices.create({
      customer: cust.id, collection_method: 'send_invoice', days_until_due: 0, auto_advance: false, ...r.params,
      metadata: {
        orderReference: `test-hold-${Date.now()}`, kind, transferDollars: String(TRANSFER), connectedAccountId: ACCT,
        withholdPayouts: pay.withholdPayouts ? '1' : '0', transferMode: r.routeToRestaurant ? 'destination' : 'manual',
      },
    })
    await s.invoiceItems.create({ customer: cust.id, invoice: inv.id, amount: Math.round(TOTAL * 100), currency: 'usd' })
    await s.invoices.finalizeInvoice(inv.id)
    const paid = await s.invoices.pay(inv.id, { payment_method: pm.id })
    const chId = (paid as unknown as { charge?: string }).charge as string
    const ch = await s.charges.retrieve(chId)
    const manual = invoiceNeedsManualPayout(paid as unknown as { metadata?: Stripe.Metadata | null; transfer_data?: unknown })
    if (name === 'held') {
      await sleep(4000)
      const later = await s.charges.retrieve(ch.id)
      check(paid.status === 'paid' && !later.transfer && !manual, `${label}, held: paid in full, no transfer on the charge, and the webhook will not push one`)
      if (routed) check(later.on_behalf_of === ACCT, `${label}, held: still on the restaurant's behalf ("${later.calculated_statement_descriptor}")`)
    } else if (routed) {
      check(!!ch.transfer && !manual, `${label}, not held: Stripe pays the restaurant from the charge, and the webhook does not pay twice`)
    } else {
      check(!ch.transfer && manual, `${label}, not held: the webhook pushes the restaurant's share`)
    }
    await sleep(300)
  }
}

async function main() {
  console.log('\n=== 0. the hold decision ===')
  check(payoutHoldFrom({ money_flow: 'FAMILY_MEAL', withhold_payouts: false }) === 'hold_payments', 'Hold Payments on holds')
  check(payoutHoldFrom({ money_flow: 'DIRECT', withhold_payouts: true }) === 'withhold_payouts', 'the old switch still holds')
  check(payoutHoldFrom({ money_flow: 'DIRECT', withhold_payouts: false }) === null && payoutHoldFrom(undefined) === null, 'otherwise paid out')

  console.log('\n=== 1. card checkout (one-time) ===')
  await cardPath('card checkout', {})

  console.log('\n=== 2. saved card / recurring (off-session) ===')
  const cust = await s.customers.create({ email: 'hold-recurring@example.com' })
  const pm = await s.paymentMethods.attach('pm_card_visa', { customer: cust.id })
  await cardPath('recurring', { customerId: cust.id, paymentMethodId: pm.id, offSession: true })

  console.log('\n=== 3. pay by invoice / direct entry ===')
  await invoicePath('invoice order', 'native_order_invoice', true)

  console.log('\n=== 4. order edits ===')
  await cardPath('edit card delta', { metadata: { orderReference: `test-hold-edit-${Date.now()}`, orderNumber: '0', kind: 'order_edit' } })
  await invoicePath('edit invoice', 'order_edit', false)
  await invoicePath('reissue invoice', 'order_edit_reissue', false)

  console.log('\n=== 5. refund of a held order ===')
  const pi = await createNativeOrderPaymentIntent(s, { totalDollars: TOTAL, transferDollars: TRANSFER, ...held, onBehalfOf: true, paymentMethodId: 'pm_card_visa', confirm: true })
  const rf = await s.refunds.create({ payment_intent: pi.id, amount: 5000 })
  check(rf.status === 'succeeded' || rf.status === 'pending', 'a held order refunds from the held money (plain platform refund)')

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
