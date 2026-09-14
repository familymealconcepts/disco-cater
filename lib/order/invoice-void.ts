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
