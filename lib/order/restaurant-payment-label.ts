import type Stripe from 'stripe'
import { sql } from '../db'

// ORDER NUMBER AND CUSTOMER NAME ON EVERY PAYMENT IN THE RESTAURANT'S OWN STRIPE (Peter, 2026-11-20).
//
// WHY. A restaurant's accountant reconciles bank deposits against Stripe, and Stripe showed them only
// bare amounts: the payment a transfer creates in the restaurant's account (py_…) carries no
// description and no metadata, so "$177.10 on 10/21" could not be traced to anything
// (a restaurant accountant, Nov 2026). The order lives on the PLATFORM charge, which the restaurant
// never sees.
//
// WHAT. Every dollar Disco or FamilyMeal sends a restaurant arrives as a transfer, and every transfer
// creates one payment in the restaurant's account. labelTransferPayment writes the order number and
// customer name onto that payment, as its description and metadata. FamilyMeal's older direct invoices
// (charged on the restaurant's own account, "Payment for Invoice") are labelled by labelDirectCharge.
//
// NO MONEY MOVES. Only description and metadata are written, on the restaurant's account, and only
// when they differ. A transfer that resolves to no order (one sent by hand from the Dashboard) is left
// as it is: inventing a label for it would be worse than a blank.
//
// Callers: the Stripe webhook on transfer.created (app/api/stripe/webhook/route.ts), the one-time
// backfill (scripts/backfill-restaurant-payment-labels.ts). The portal's Payouts report, which reads
// the labels back, is held unshipped (Peter, 2026-11-23).

export const LABEL_METADATA_KEY = 'disco_label'

export interface PaymentOrder {
  orderNumber: string
  customerName: string
  /** Disco's order reference when the order is in Disco; null when only the charge named it. */
  orderReference: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null

/** What kind of money a transfer is, from the metadata Disco puts on the ones it creates by hand. Pure. */
export function transferPurpose(metadata: Record<string, string> | null | undefined): string | null {
  switch (metadata?.kind) {
    case 'native_edit_payout': return 'order edit'
    case 'stripe_fee_trueup': return 'Stripe fee adjustment'
    default: return null
  }
}

/** "Order #12345678 · Jane Doe", plus what the money is when it isn't the order's payment. Pure. */
export function paymentDescription(o: PaymentOrder, purpose?: string | null): string {
  const name = o.customerName.trim()
  return `Order #${o.orderNumber}${name ? ` · ${name}` : ''}${purpose ? ` (${purpose})` : ''}`
}

/** FamilyMeal's charge description starts "Receipt # 12345678;" — the order number when Disco has no row yet. Pure. */
export function receiptNumber(description: string | null | undefined): string | null {
  const m = /Receipt\s*#\s*(\d+)/i.exec(description ?? '')
  return m ? m[1] : null
}

/** The order an order reference names: Disco's own reference, or FamilyMeal's for a copied order. */
export async function orderForReference(ref: string | null | undefined): Promise<PaymentOrder | null> {
  const r = String(ref ?? '').trim()
  if (!UUID_RE.test(r)) return null
  const rows = (await sql`
    SELECT order_number::text AS order_number, reference::text AS reference,
           TRIM(CONCAT_WS(' ', NULLIF(TRIM(customer_first_name), ''), NULLIF(TRIM(customer_last_name), ''))) AS customer_name
      FROM disco_orders
     WHERE (reference = ${r}::uuid OR fm_order_reference = ${r}::uuid) AND is_deleted = false
     ORDER BY (reference = ${r}::uuid) DESC
     LIMIT 1
  `) as { order_number: string; reference: string; customer_name: string | null }[]
  if (!rows.length || !rows[0].order_number) return null
  return { orderNumber: rows[0].order_number, customerName: rows[0].customer_name ?? '', orderReference: rows[0].reference }
}

/** The order a PLATFORM charge paid for: its orderReference (Disco's or FamilyMeal's), else FamilyMeal's receipt number. */
export async function orderForPlatformCharge(charge: Stripe.Charge): Promise<PaymentOrder | null> {
  const meta = (charge.metadata ?? {}) as Record<string, string>
  const found = await orderForReference(meta.orderReference)
  if (found) return found
  // A FamilyMeal order can reach Stripe before it is copied into Disco: the charge still names it.
  const number = meta.orderNumber || receiptNumber(charge.description)
  if (!number) return null
  return { orderNumber: number, customerName: charge.billing_details?.name ?? '', orderReference: null }
}

/** The order a transfer paid: its own metadata, Disco's payment records, then the charge that funded it. */
export async function orderForTransfer(stripe: Stripe, transfer: Stripe.Transfer): Promise<PaymentOrder | null> {
  const meta = (transfer.metadata ?? {}) as Record<string, string>
  const byMeta = await orderForReference(meta.orderReference)
  if (byMeta) return byMeta
  const { resolveTransferOrder } = await import('./transfer-reversals')
  const byRecord = await orderForReference(await resolveTransferOrder(transfer.id, transfer.transfer_group ?? null))
  if (byRecord) return byRecord
  const src = idOf(transfer.source_transaction)
  if (!src?.startsWith('ch_') && !src?.startsWith('py_')) return null
  const charge = await stripe.charges.retrieve(src)
  return orderForPlatformCharge(charge)
}

export type LabelOutcome = 'labelled' | 'unchanged' | 'no-order' | 'no-payment'

/** Write the label onto a payment in the restaurant's account, only if it differs. */
async function writeLabel(stripe: Stripe, account: string, paymentId: string, current: Stripe.Charge | null,
  o: PaymentOrder, purpose: string | null, dryRun: boolean): Promise<LabelOutcome> {
  const description = paymentDescription(o, purpose)
  const metadata: Record<string, string> = {
    order_number: o.orderNumber,
    customer_name: o.customerName.slice(0, 500),
    ...(o.orderReference ? { order_reference: o.orderReference } : {}),
    ...(purpose ? { purpose } : {}),
    [LABEL_METADATA_KEY]: '1',
  }
  const have = current ?? await stripe.charges.retrieve(paymentId, {}, { stripeAccount: account })
  const same = have.description === description &&
    Object.entries(metadata).every(([k, v]) => (have.metadata as Record<string, string> | null)?.[k] === v)
  if (same) return 'unchanged'
  if (!dryRun) await stripe.charges.update(paymentId, { description, metadata }, { stripeAccount: account })
  return 'labelled'
}

/** Label the payment a transfer created in the restaurant's account. Never moves money. */
export async function labelTransferPayment(stripe: Stripe, transfer: Stripe.Transfer, opts: { dryRun?: boolean } = {}): Promise<{ outcome: LabelOutcome; order: PaymentOrder | null; description?: string }> {
  const account = idOf(transfer.destination)
  const payment = idOf(transfer.destination_payment)
  if (!account || !payment) return { outcome: 'no-payment', order: null }
  const order = await orderForTransfer(stripe, transfer)
  if (!order) return { outcome: 'no-order', order: null }
  const purpose = transferPurpose(transfer.metadata as Record<string, string>)
  const outcome = await writeLabel(stripe, account, payment, null, order, purpose, opts.dryRun === true)
  return { outcome, order, description: paymentDescription(order, purpose) }
}

/** A charge's invoice (id or object). The SDK's Charge type at this API version omits the field Stripe still sends. */
export const chargeInvoice = (charge: Stripe.Charge): string | Stripe.Invoice | null =>
  (charge as unknown as { invoice?: string | Stripe.Invoice | null }).invoice ?? null

/** The order a FamilyMeal direct invoice charge (on the restaurant's own account) paid: its invoice's orderReference. */
export async function orderForDirectCharge(stripe: Stripe, account: string, charge: Stripe.Charge): Promise<PaymentOrder | null> {
  const field = chargeInvoice(charge)
  const inv = field && typeof field === 'object' ? field as Stripe.Invoice
    : idOf(field) ? await stripe.invoices.retrieve(idOf(field)!, {}, { stripeAccount: account }) : null
  const ref = (inv?.metadata as Record<string, string> | undefined)?.orderReference ?? (charge.metadata as Record<string, string>)?.orderReference
  return orderForReference(ref)
}

/** Label a FamilyMeal direct invoice charge from its invoice's orderReference. */
export async function labelDirectCharge(stripe: Stripe, account: string, charge: Stripe.Charge, opts: { dryRun?: boolean } = {}): Promise<{ outcome: LabelOutcome; order: PaymentOrder | null; description?: string }> {
  const order = await orderForDirectCharge(stripe, account, charge)
  if (!order) return { outcome: 'no-order', order: null }
  const outcome = await writeLabel(stripe, account, charge.id, charge, order, null, opts.dryRun === true)
  return { outcome, order, description: paymentDescription(order, null) }
}

/** Webhook entry point (transfer.created). In the background, never fatal. */
export async function labelTransferPaymentForEvent(stripe: Stripe, event: Stripe.Event): Promise<void> {
  if (event.type !== 'transfer.created') return
  const transfer = event.data.object as Stripe.Transfer
  try {
    const r = await labelTransferPayment(stripe, transfer)
    if (r.outcome === 'no-order') console.log('[payment-label] transfer with no order, left unlabelled:', transfer.id)
  } catch (e) {
    console.error('[payment-label] could not label', transfer.id, '(non-fatal):', e instanceof Error ? e.message : e)
  }
}
