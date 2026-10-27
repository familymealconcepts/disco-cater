import Stripe from 'stripe'
import { sql } from '../db'

export type VoidInvoiceResult =
  | { action: 'none'; reason: string }
  | { action: 'voided'; invoiceId: string }
  | { action: 'failed'; invoiceId: string | null; error: string }

interface InvoiceOrderRow {
  id: number
  order_status: string | null
  stripe_invoice_id: string | null
  stripe_invoice_status: string | null
}

// Void the open Stripe invoice behind an UNPAID native invoice order.
//
// WHY THIS EXISTS, and why it is not a refund: cancelling an order left its
// Stripe invoice OPEN and payable. A customer could pay a cancelled order; the
// webhook's UNPAID→DUE update would no-op (it is guarded on UNPAID) while the
// payout transfer fired anyway — money collected, restaurant paid, order
// CANCELED, kitchen never told.
//
// Voiding an unpaid invoice moves NO money. It withdraws a bill that should
// never be paid. That is categorically different from refunding, which returns
// money a customer already handed over, and which stays a separate deliberate
// action (see the status route's header). This is the ONLY Stripe call the
// cancel path makes, and it is reached only when ALL of these hold:
//   - the caller is cancelling, AND
//   - the order is UNPAID, AND
//   - it carries a stripe_invoice_id whose stored status is still 'open'.
// Any paid, already-void, or card-paid order falls straight through untouched.
export async function voidUnpaidOrderInvoice(ref: string, stripe: Stripe | null): Promise<VoidInvoiceResult> {
  let row: InvoiceOrderRow | undefined
  try {
    const rows = (await sql`
      SELECT id, order_status, stripe_invoice_id, stripe_invoice_status
      FROM disco_orders
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as InvoiceOrderRow[]
    row = rows[0]
  } catch (e) {
    // A lookup failure must not be read as "nothing to void" — that is exactly
    // the silent path this function exists to close.
    return { action: 'failed', invoiceId: null, error: e instanceof Error ? e.message : String(e) }
  }

  if (!row) return { action: 'none', reason: 'no-neon-row' }
  if (String(row.order_status || '').toUpperCase() !== 'UNPAID') return { action: 'none', reason: 'not-unpaid' }
  if (!row.stripe_invoice_id) return { action: 'none', reason: 'no-invoice' }
  const stored = String(row.stripe_invoice_status || '').toLowerCase()
  if (stored === 'void') return { action: 'none', reason: 'already-void' }
  if (stored === 'paid') return { action: 'none', reason: 'already-paid' }

  if (!stripe) return { action: 'failed', invoiceId: row.stripe_invoice_id, error: 'Stripe is not configured' }

  try {
    // Read Stripe first: it, not Neon, is the authority on whether this invoice
    // can still be paid. Voiding a paid invoice is an error, and a race where the
    // customer paid seconds ago must not be reported as a clean cancel.
    const live = await stripe.invoices.retrieve(row.stripe_invoice_id)
    if (live.status === 'paid') {
      await sql`UPDATE disco_orders SET stripe_invoice_status = 'paid', updated_at = NOW() WHERE id = ${row.id}`
        .catch(() => {})
      return { action: 'failed', invoiceId: row.stripe_invoice_id, error: 'This invoice has already been paid. Refund it instead of cancelling.' }
    }
    if (live.status === 'void') {
      await sql`UPDATE disco_orders SET stripe_invoice_status = 'void', updated_at = NOW() WHERE id = ${row.id}`
      return { action: 'none', reason: 'already-void-in-stripe' }
    }
    await stripe.invoices.voidInvoice(row.stripe_invoice_id)
    await sql`UPDATE disco_orders SET stripe_invoice_status = 'void', updated_at = NOW() WHERE id = ${row.id}`
    return { action: 'voided', invoiceId: row.stripe_invoice_id }
  } catch (e) {
    return { action: 'failed', invoiceId: row.stripe_invoice_id, error: e instanceof Error ? e.message : String(e) }
  }
}

// Void the open invoice for an UNPAID EDIT when its order is cancelled.
//
// An edit that raised a native order's total, with no card to charge, is billed
// on its own invoice (disco_orders.pending_stripe_invoice_id, edit_status
// 'pending_payment'), separate from the order's own invoice above. Cancelling
// voided only the order's invoice, so the edit's stayed payable: if the customer
// paid it after the cancel, applyPendingEdit still ran and the restaurant was
// still paid its share of a cancelled order. Same rules as above: Stripe is read
// first, a paid invoice is never voided, nothing else moves.
export type VoidEditInvoiceResult =
  | { action: 'none'; reason: string }
  | { action: 'voided'; invoiceId: string; amount: number | null }
  | { action: 'failed'; invoiceId: string | null; error: string }

export async function voidPendingEditInvoice(ref: string, stripe: Stripe | null): Promise<VoidEditInvoiceResult> {
  let row: { id: number; reference: string; edit_status: string | null; pending_stripe_invoice_id: string | null; pending_edit_delta: string | null } | undefined
  try {
    const rows = (await sql`
      SELECT id, reference::text AS reference, edit_status, pending_stripe_invoice_id, pending_edit_delta
      FROM disco_orders
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as NonNullable<typeof row>[]
    row = rows[0]
  } catch (e) {
    return { action: 'failed', invoiceId: null, error: e instanceof Error ? e.message : String(e) }
  }
  if (!row) return { action: 'none', reason: 'no-neon-row' }
  if (row.edit_status !== 'pending_payment' || !row.pending_stripe_invoice_id) return { action: 'none', reason: 'no-pending-edit' }
  const invoiceId = row.pending_stripe_invoice_id
  if (!stripe) return { action: 'failed', invoiceId, error: 'Stripe is not configured' }

  try {
    const live = await stripe.invoices.retrieve(invoiceId)
    // Paid: the webhook applies the edit; there is nothing to withdraw.
    if (live.status === 'paid') return { action: 'none', reason: 'edit-invoice-paid' }
    if (live.status !== 'void') await stripe.invoices.voidInvoice(invoiceId)
    await sql`
      UPDATE disco_orders SET edit_status = NULL, pending_stripe_invoice_id = NULL, updated_at = NOW()
      WHERE id = ${row.id} AND pending_stripe_invoice_id = ${invoiceId}
    `
    await sql`UPDATE disco_order_edits SET payment_status = 'voided' WHERE stripe_invoice_id = ${invoiceId}`
      .catch(e => console.error('[invoice-void] edit row (non-fatal):', e instanceof Error ? e.message : e))
    const amount = row.pending_edit_delta != null ? Number(row.pending_edit_delta) : null
    return { action: 'voided', invoiceId, amount: Number.isFinite(amount as number) ? amount : null }
  } catch (e) {
    return { action: 'failed', invoiceId, error: e instanceof Error ? e.message : String(e) }
  }
}
