// Stripe TEST MODE check of the Stripe-fee true-up (lib/order/stripe-fee-trueup.ts) and the
// capped-reversal shortfall (lib/order/refund-stripe-fee.ts capShortfallCents). Stripe only —
// no database writes. Refuses to run with anything but an sk_test_ key.
//   npx tsx scripts/verify-fee-trueup-testmode.ts
import { config } from 'dotenv'; config({ path: '.env.local', quiet: true } as never)
import Stripe from 'stripe'
import { settleFeeDifference, trueupDelta } from '../lib/order/stripe-fee-trueup'
import { capShortfallCents, refundFeeShare } from '../lib/order/refund-stripe-fee'

const key = process.env.STRIPE_SECRET_KEY || ''
if (!key.startsWith('sk_test_')) { console.error('Refusing: STRIPE_SECRET_KEY is not a test key.'); process.exit(1) }
const s = new Stripe(key, { apiVersion: '2025-01-27.acacia' } as never)
const ACCT = process.argv[2] || 'acct_1Toa9bKmFeY8kpjq'   // a test connected account with payouts to spare
const $ = (c: number) => `$${(c / 100).toFixed(2)}`
let failures = 0
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++ }

/** A checkout-shaped destination charge: transfer = total − Disco's 10% − the ESTIMATED fee. */
async function charge(pm: string, totalCents: number) {
  const est = Math.round(totalCents * 0.029 + 30)
  const transfer = totalCents - Math.round(totalCents * 0.10) - est
  const pi = await s.paymentIntents.create({
    amount: totalCents, currency: 'usd', payment_method: pm, confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    transfer_data: { destination: ACCT, amount: transfer }, on_behalf_of: ACCT,
  })
  let ch = await s.charges.retrieve(pi.latest_charge as string, { expand: ['balance_transaction'] })
  for (let i = 0; i < 20 && !ch.balance_transaction; i++) { await new Promise(r => setTimeout(r, 1500)); ch = await s.charges.retrieve(ch.id, { expand: ['balance_transaction'] }) }
  const fee = (ch.balance_transaction as Stripe.BalanceTransaction).fee
  return { pi, ch, est, transfer, fee, tr: ch.transfer as string }
}
const net = async (tr: string) => { const t = await s.transfers.retrieve(tr); return t.amount - (t.amount_reversed ?? 0) }

async function main() {
  console.log('\n=== 1. actual fee vs estimate, by card ===')
  const cards: Record<string, string> = {
    'Visa (US)': 'pm_card_visa', 'Amex (US)': 'pm_card_amex', 'Visa (Brazil)': 'pm_card_br',
    'Visa (UK)': 'pm_card_gb', 'Visa (Mexico)': 'pm_card_mx',
  }
  const results: Record<string, Awaited<ReturnType<typeof charge>>> = {}
  for (const [name, pm] of Object.entries(cards)) {
    try { const r = await charge(pm, 47917); results[name] = r; console.log(`  ${name.padEnd(14)} charge $479.17  estimate ${$(r.est)}  actual ${$(r.fee)}  difference ${$(r.fee - r.est)}`) }
    catch (e) { console.log(`  ${name.padEnd(14)} could not charge: ${(e as Error).message.slice(0, 80)}`) }
  }

  console.log('\n=== 2. true-up moves exactly the difference ===')
  const over = Object.entries(results).find(([, r]) => r.fee > r.est)
  if (!over) console.log('  (no test card produced a fee above the estimate — skipped)')
  else {
    const [name, r] = over
    const delta = trueupDelta(r.fee, r.est, r.ch.amount_captured, 0)
    const before = await net(r.tr)
    const res = await settleFeeDifference(s, { chargeId: r.ch.id, orderReference: `test-${r.pi.id}`, payoutTransferId: r.tr, deltaCents: delta })
    const after = await net(r.tr)
    check(res.how === 'reversal' && res.settledCents === delta && before - after === delta, `${name}: reversed ${$(before - after)} = difference ${$(delta)}`)
    check(after === r.ch.amount_captured - Math.round(r.ch.amount_captured * 0.10) - r.fee, `${name}: restaurant now bears the actual fee (${$(after)} net)`)
    const again = await settleFeeDifference(s, { chargeId: r.ch.id, orderReference: `test-${r.pi.id}`, payoutTransferId: r.tr, deltaCents: delta })
    check(again.moveId === res.moveId && (await net(r.tr)) === after, 'a second run is a no-op (same reversal, nothing moved)')
  }
  {
    // A fee BELOW the estimate (e.g. a bank debit) is paid to the restaurant. Forced: estimate + $1.00.
    const r = results['Visa (US)']
    const before = await net(r.tr)
    const res = await settleFeeDifference(s, { chargeId: r.ch.id, orderReference: `test-${r.pi.id}`, payoutTransferId: r.tr, deltaCents: -100 })
    const topup = await s.transfers.retrieve(res.moveId as string)
    check(res.how === 'topup' && topup.amount === 100 && topup.source_transaction === r.ch.id && (await net(r.tr)) === before,
      `fee below estimate: ${$(topup.amount)} paid to the restaurant by a separate transfer funded by the charge`)
  }

  console.log('\n=== 3. Stripe caps reverse_transfer at what is left (the leak) ===')
  {
    const r = await charge('pm_card_visa', 10000)   // transfer 10000 − 1000 − 320 = 8680
    const re1 = await s.refunds.create({ payment_intent: r.pi.id, amount: 4000, reverse_transfer: true })
    const fee1 = refundFeeShare(r.fee, 10000, 0, 4000)
    await s.transfers.createReversal(r.tr, { amount: fee1, metadata: { kind: 'refund_stripe_fee' } })   // refund-fee from own payout
    const re2 = await s.refunds.create({ payment_intent: r.pi.id, amount: 6000, reverse_transfer: true }, { expand: ['transfer_reversal'] } as never)
    const rev2 = (await s.refunds.retrieve(re2.id, { expand: ['transfer_reversal'] }) as unknown as { transfer_reversal: Stripe.TransferReversal }).transfer_reversal.amount
    const expected = Math.round(r.transfer * 0.6)
    const short = capShortfallCents(r.transfer, 6000, 10000, rev2)
    console.log(`  second refund should reverse ${$(expected)}, Stripe reversed ${$(rev2)}`)
    check(short === expected - rev2 && short === fee1, `shortfall measured ${$(short)} = the fee taken from the payout earlier (${$(fee1)})`)
    void re1
  }
  {
    // After a true-up reversal, a full refund is capped by the true-up amount.
    const r = await charge('pm_card_visa', 10000)
    await s.transfers.createReversal(r.tr, { amount: 250, metadata: { kind: 'stripe_fee_trueup' } })
    const re = await s.refunds.create({ payment_intent: r.pi.id, amount: 10000, reverse_transfer: true })
    const rev = (await s.refunds.retrieve(re.id, { expand: ['transfer_reversal'] }) as unknown as { transfer_reversal: Stripe.TransferReversal }).transfer_reversal.amount
    const short = capShortfallCents(r.transfer, 10000, 10000, rev)
    check(short === 250, `after a $2.50 true-up, a full refund reversed ${$(rev)} of ${$(r.transfer)}: shortfall ${$(short)} is collected`)
  }
  console.log(failures ? `\nFAILED ${failures}` : '\nALL PASS')
  if (failures) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })
