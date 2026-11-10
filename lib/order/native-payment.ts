// Native (zero-FM) order payment: a Stripe destination charge on the platform
// account that routes the restaurant's payout to its connected account and keeps
// Disco's cut (total − transfer) on the platform. Merchant-of-record is the
// restaurant (on_behalf_of), matching the FM DIRECT model.
//
// Money rules (see docs/native-menu-parity-plan.md 1f):
//   customer charged  = breakdown.total   (cents)
//   restaurant payout = breakdown.transfer (cents)  → transfer_data.amount
//   Disco keeps       = total − transfer            (stays on the platform)
//   HELD              → OMIT transfer_data: the whole charge stays on the platform
//                       (funds held with Disco); the order still completes and looks
//                       exactly like any other order everywhere (statement name,
//                       receipts, emails, portal, reports, Super Admin). Withholding is
//                       tracked outside Disco; the charge's metadata (payoutHeld,
//                       restaurantPayoutAmount) is the only internal record.
//
// HELD MEANS HOLD PAYMENTS (Peter, 2026-11-10). A restaurant's payout is held when the Super Admin
// Hold Payments toggle is on (disco_restaurant_overrides.money_flow = 'FAMILY_MEAL', the value
// lib/money-flow-sync.ts keeps equal to FamilyMeal's) OR the older withhold_payouts switch is on.
// Before this only withhold_payouts was read, and it was never set for anyone, so every Disco-checkout
// order at a held restaurant was paid out anyway (Apollo Bagels - Kips Bay, Maciel's and others).
// Every payment path reads this one function: card checkout, saved-card and recurring charges, pay by
// invoice / direct entry, and order edits (card delta and edit invoices, whose metadata the webhook
// obeys). It is read when the charge or invoice is created, so turning the hold off affects new orders
// only; an invoice sent while held stays held when it is paid.

import Stripe from 'stripe'
import { sql } from '../db'
import { cents } from '../promo-pricing'
import { alertOps } from '../ops-alert'
import { shortError } from '../ops-alert-format'

export const STRIPE_API_VERSION = '2025-01-27.acacia'

export function stripeClient(secretKey: string | undefined): Stripe | null {
  if (!secretKey) return null
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION } as unknown as ConstructorParameters<typeof Stripe>[1])
}

export interface RestaurantPayoutConfig {
  connectedAccountId: string | null
  /** The restaurant's share is held on the platform: Hold Payments on, or withhold_payouts. */
  withholdPayouts: boolean
  /** Why it is held, for the records; null when it is not. 'read_failed': the setting couldn't be read. */
  holdSource: 'hold_payments' | 'withhold_payouts' | 'read_failed' | null
}

/** Pure: the hold decision from the overrides row. Pinned by scripts/tests/native-hold-payments.test.ts. */
export function payoutHoldFrom(row: { money_flow?: string | null; withhold_payouts?: boolean | null } | undefined): RestaurantPayoutConfig['holdSource'] {
  if (row?.money_flow === 'FAMILY_MEAL') return 'hold_payments'
  if (row?.withhold_payouts === true) return 'withhold_payouts'
  return null
}

// Resolve a restaurant's Stripe connected account + payout-hold flag from Neon.
// Restaurant archiving (lib/disco-restaurant-archive.ts) MUST NEVER write
// withhold_payouts or stripe_account_id, and must never interrupt an in-flight
// PaymentIntent or pending transfer — archiving hides a storefront and portal
// access, not money. A pending payout for an archived restaurant completes
// normally. (In practice an archived restaurant's checkout is already
// unreachable — the storefront is gone — so this function simply won't be
// called for new orders; it stays untouched for the same reason existing
// orders' refunds still work after Stripe is disconnected.)
export async function getRestaurantPayoutConfig(restaurantReference: string): Promise<RestaurantPayoutConfig> {
  // Ordering is never blocked by withholding (Peter, 2026-11-10). A failed read is retried once; if it
  // still fails the order goes through with the restaurant's share HELD on the platform (never sent, so a
  // held restaurant is never paid out by mistake) and ops is alerted to send it by hand if the restaurant
  // isn't on hold. A failed read used to throw, which stopped the payment.
  let ovrRows: { stripe_account_id: string | null; withhold_payouts: boolean | null; money_flow: string | null }[] | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2 && !ovrRows; attempt++) {
    try {
      ovrRows = (await sql`
        SELECT stripe_account_id, withhold_payouts, money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantReference} LIMIT 1
      `) as { stripe_account_id: string | null; withhold_payouts: boolean | null; money_flow: string | null }[]
    } catch (e) { lastError = e }
  }
  if (!ovrRows) {
    await alertOps({
      severity: 'urgent',
      headline: "A Disco order is going through with the restaurant's share held: its Hold Payments setting couldn't be read",
      lines: [
        `Restaurant ${restaurantReference}, at ${new Date().toISOString()}.`,
        `The order is not blocked. If it is paid, the restaurant's share stays on Disco's Stripe account. ${shortError(lastError)}`,
      ],
      action: "find the order in Stripe (metadata holdSource = read_failed). If the restaurant isn't on Hold Payments, send its share by hand.",
      context: { restaurantReference, error: shortError(lastError, 500) },
    })
    return { connectedAccountId: null, withholdPayouts: true, holdSource: 'read_failed' }
  }
  const holdSource = payoutHoldFrom(ovrRows[0])
  return {
    connectedAccountId: ovrRows[0]?.stripe_account_id ?? null,
    withholdPayouts: holdSource !== null,
    holdSource,
  }
}

export interface NativePaymentParams {
  totalDollars: number      // customer charge
  transferDollars: number   // restaurant payout
  connectedAccountId: string | null
  withholdPayouts: boolean
  /** Recorded on a held charge; 'read_failed' tells ops the hold setting couldn't be read. */
  holdSource?: RestaurantPayoutConfig['holdSource']
  customerId?: string
  receiptEmail?: string      // diner email → shown on the charge + Stripe receipt
  paymentMethodId?: string  // set for server-side confirm (tests); omit for client-side confirm
  onBehalfOf?: boolean       // restaurant as merchant-of-record (production); omit for the test account
  confirm?: boolean          // confirm immediately server-side (recurring/off-session); omit for client confirm
  offSession?: boolean       // customer not present (recurring auto-charge)
  metadata?: Record<string, string>
  description?: string
}

// Resolve (or create) the platform-account Stripe Customer for a diner, keyed by
// email, so the destination charge is attached to a real Customer object instead
// of showing no customer in the Stripe dashboard. Reuses a stored id when we have
// one, else an existing Stripe customer with that email, else creates a new one.
// Best-effort and never throws — returns null if Stripe/Neon are unavailable so
// order placement still proceeds (the charge just won't carry a Customer).
export async function getOrCreateStripeCustomer(stripe: Stripe, email: string | null | undefined, name?: string | null): Promise<string | null> {
  const e = String(email || '').trim().toLowerCase()
  if (!e) return null
  // 1) Reuse a previously-stored Stripe customer id for this diner.
  try {
    const rows = (await sql`SELECT stripe_customer_id FROM disco_customers WHERE email = ${e} AND stripe_customer_id IS NOT NULL LIMIT 1`) as { stripe_customer_id: string | null }[]
    if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id
  } catch { /* column may not exist yet — fall through to Stripe */ }
  // 2) Reuse an existing Stripe customer with this email, else create one.
  let id: string | null = null
  try {
    const found = await stripe.customers.list({ email: e, limit: 1 })
    id = found.data[0]?.id ?? null
  } catch { /* fall through to create */ }
  if (!id) {
    try {
      const c = await stripe.customers.create({ email: e, ...(name ? { name } : {}) })
      id = c.id
    } catch { return null }
  }
  // 3) Persist for reuse (best-effort; no-op if the column isn't there yet).
  if (id) { try { await sql`UPDATE disco_customers SET stripe_customer_id = ${id} WHERE email = ${e}` } catch { /* best-effort */ } }
  return id
}

/**
 * The money routing of a native invoice (pay by invoice, direct entry): a destination invoice whose charge
 * moves the restaurant's share itself, or, when the payout is held or there is no account, a plain
 * platform invoice that keeps the whole payment. Shared by placeNativeInvoiceOrder and the test-mode
 * check (scripts/verify-native-hold-testmode.ts), so the test exercises what production sends.
 */
export function nativeInvoiceRouting(pay: Pick<RestaurantPayoutConfig, 'connectedAccountId' | 'withholdPayouts'>, transferDollars: number): {
  routeToRestaurant: boolean
  params: Pick<Stripe.InvoiceCreateParams, 'on_behalf_of' | 'transfer_data'>
} {
  const routeToRestaurant = !pay.withholdPayouts && !!pay.connectedAccountId && transferDollars > 0
  return {
    routeToRestaurant,
    // A held invoice is still the restaurant's (on_behalf_of: its name, as on any other order); only the
    // transfer is left off (Peter, 2026-11-10: held orders look and behave exactly like normal ones).
    params: routeToRestaurant
      ? { on_behalf_of: pay.connectedAccountId as string, transfer_data: { destination: pay.connectedAccountId as string, amount: cents(transferDollars) } }
      : pay.connectedAccountId ? { on_behalf_of: pay.connectedAccountId } : {},
  }
}

/**
 * Whether the paid-invoice webhook must push the restaurant's share with its own transfer: only for an
 * invoice that did not route it (no transfer_data, not 'destination'), that was not created as held, and
 * that names an account and a positive share. Every native invoice kind (order, reissue, edit) asks this.
 */
export function invoiceNeedsManualPayout(invoice: { metadata?: Stripe.Metadata | null; transfer_data?: unknown }): boolean {
  const m = invoice.metadata ?? {}
  const stripeMovedIt = !!invoice.transfer_data || m.transferMode === 'destination'
  const withhold = m.withholdPayouts === '1'
  return !stripeMovedIt && !withhold && !!m.connectedAccountId && Number(m.transferDollars || 0) > 0
}

// Build the destination-charge PaymentIntent. When withheld (or no connected
// account), transfer_data is omitted so the whole charge stays on the platform. Nothing else changes: the
// charge is still on the restaurant's behalf, with the same description and receipt. The only record that
// it was held is internal metadata (payoutHeld, restaurantPayoutAmount: the share owed), read by
// lib/order/stripe-facts.ts so reports show the payout as on any other order.
export async function createNativeOrderPaymentIntent(stripe: Stripe, p: NativePaymentParams, idempotencyKey?: string): Promise<Stripe.PaymentIntent> {
  const routeToRestaurant = !p.withholdPayouts && !!p.connectedAccountId
  const heldMeta: Record<string, string> = routeToRestaurant ? {} : { payoutHeld: '1', restaurantPayoutAmount: (cents(p.transferDollars) / 100).toFixed(2), ...(p.holdSource ? { holdSource: p.holdSource } : {}) }
  const params: Stripe.PaymentIntentCreateParams = {
    amount: cents(p.totalDollars),
    currency: 'usd',
    ...(p.description ? { description: p.description } : {}),
    ...(p.metadata || !routeToRestaurant ? { metadata: { ...(p.metadata ?? {}), ...heldMeta } } : {}),
    ...(p.customerId ? { customer: p.customerId } : {}),
    ...(p.receiptEmail ? { receipt_email: p.receiptEmail } : {}),
    ...(p.paymentMethodId ? { payment_method: p.paymentMethodId } : {}),
    // Server-side confirm for off-session recurring charges (B1). Omitted for the
    // client-confirm one-time flow, so that path is byte-for-byte unchanged.
    ...(p.confirm ? { confirm: true } : {}),
    ...(p.offSession ? { off_session: true } : {}),
    ...(routeToRestaurant
      ? { transfer_data: { destination: p.connectedAccountId as string, amount: cents(p.transferDollars) } }
      : {}),
    // Held or not, the charge is made on the restaurant's behalf, so the diner's statement and receipt name
    // the restaurant exactly as on any other order (Peter, 2026-11-10). Holding only leaves off transfer_data.
    ...(p.connectedAccountId && p.onBehalfOf ? { on_behalf_of: p.connectedAccountId } : {}),
    // Native checkout is ALWAYS a card charge — confirmed client-side via Stripe.js
    // confirmCardPayment, or server-side with a supplied payment_method (tests).
    // Use an explicit card-only PaymentIntent: automatic_payment_methods breaks the
    // legacy confirmCardPayment on an on_behalf_of PI (it returns an error even
    // though the charge succeeds, so the client showed a false failure and never
    // reached the confirmation screen — Bug 1).
    payment_method_types: ['card'],
  }
  return stripe.paymentIntents.create(params, idempotencyKey ? { idempotencyKey } : undefined)
}
