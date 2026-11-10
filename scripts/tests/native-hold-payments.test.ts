// Guards for Hold Payments on Disco's own checkout (Peter, 2026-11-10): the hold decision, the paid-invoice
// payout decision, and that every payment path takes its answer from getRestaurantPayoutConfig. No network.
// The Stripe test-mode run is scripts/verify-native-hold-testmode.ts.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { invoiceNeedsManualPayout, nativeInvoiceRouting, payoutHoldFrom } from '../../lib/order/native-payment'

let n = 0
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++ }

ok(payoutHoldFrom({ money_flow: 'FAMILY_MEAL', withhold_payouts: false }) === 'hold_payments', 'Hold Payments on holds')
ok(payoutHoldFrom({ money_flow: 'DIRECT', withhold_payouts: true }) === 'withhold_payouts', 'the older switch still holds')
ok(payoutHoldFrom({ money_flow: 'DIRECT', withhold_payouts: false }) === null && payoutHoldFrom({ money_flow: null }) === null && payoutHoldFrom(undefined) === null, 'otherwise not held')

const held = nativeInvoiceRouting({ connectedAccountId: 'acct_x', withholdPayouts: true }, 100)
ok(!held.routeToRestaurant && !('transfer_data' in held.params) && held.params.on_behalf_of === 'acct_x', 'a held invoice is still on the restaurant\'s behalf, with no transfer')
const open = nativeInvoiceRouting({ connectedAccountId: 'acct_x', withholdPayouts: false }, 100)
ok(open.routeToRestaurant && open.params.transfer_data?.amount === 10000, 'a not-held invoice routes the share')

const meta = (m: Record<string, string>) => ({ metadata: m })
ok(!invoiceNeedsManualPayout(meta({ withholdPayouts: '1', connectedAccountId: 'acct_x', transferDollars: '10' })), 'a held invoice is never paid out by the webhook')
ok(invoiceNeedsManualPayout(meta({ withholdPayouts: '0', connectedAccountId: 'acct_x', transferDollars: '10' })), 'a not-held manual invoice is')
ok(!invoiceNeedsManualPayout({ ...meta({ withholdPayouts: '0', connectedAccountId: 'acct_x', transferDollars: '10' }), transfer_data: { destination: 'acct_x' } }), 'a destination invoice is not paid twice')
ok(!invoiceNeedsManualPayout(meta({ withholdPayouts: '0', connectedAccountId: '', transferDollars: '10' })), 'no account, no payout')

const src = (p: string) => readFileSync(p, 'utf8')
// Held orders look exactly like normal ones (Peter, 2026-11-10): on_behalf_of whatever the hold, no held
// marker on the sale row, and reports count the held share as paid out.
const payment = src('lib/order/native-payment.ts')
ok(/\.\.\.\(p\.connectedAccountId && p\.onBehalfOf \? \{ on_behalf_of: p\.connectedAccountId \} : \{\}\)/.test(payment), 'card charges are on the restaurant\'s behalf, held or not')
ok(!/moneyFlow: 'FAMILY_MEAL' \} : input/.test(src('lib/order/native-checkout.ts')), 'a held card order is recorded like any other on the sale row')
const facts = src('lib/order/stripe-facts.ts')
ok(/payoutHeld === '1'/.test(facts) && /withholdPayouts === '1'/.test(facts) && /transferred \+= h\.amount/.test(facts), 'report facts count a held share as transferred')
const pay = src('lib/order/native-payment.ts')
ok(/SELECT stripe_account_id, withhold_payouts, money_flow FROM disco_restaurant_overrides/.test(pay), 'the config reads Hold Payments (money_flow)')
ok(!/money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = \$\{restaurantReference\} LIMIT 1\s*`\.catch/.test(pay), 'a failed read is not taken as "not held"')
const checkout = src('lib/order/native-checkout.ts')
ok((checkout.match(/getRestaurantPayoutConfig\(input\.restaurantReference\)/g) || []).length === 3, 'card, invoice and recurring all read the config')
ok(/nativeInvoiceRouting\(pay, transfer\)/.test(checkout), 'the invoice path uses the shared routing')
ok(/getRestaurantPayoutConfig\(restaurantRef\)/.test(src('app/api/restaurant/orders/[ref]/edit/route.ts')), 'order edits read the config')
const webhook = src('app/api/stripe/webhook/route.ts')
ok((webhook.match(/invoiceNeedsManualPayout\(/g) || []).length === 2, 'both webhook payouts (edit and native invoice) use the shared decision')

console.log(`native-hold-payments: ALL PASS ${n} assertions`)
