// The ONE mapping from an order's status to disco_sale_transactions.transaction_status.
//
// Both FamilyMeal mirror writers (lib/fm-orders-sync.ts and
// scripts/fm-order-backfill.ts) used to insert the literal 'PAID' regardless of
// what the order actually was, so all 24,293 FM-sourced rows claimed PAID —
// including 29 UNPAID invoice orders that nobody had ever collected. They import
// this instead. Two copies of this mapping would be the third instance of the
// same drift bug this codebase keeps hitting, so there is exactly one.
//
// The column's CHECK constraint allows only three values:
//   INITIATED | PAID | VOIDED
// so the mapping has to land in that vocabulary, and the vocabulary is what makes
// the ambiguous cases tractable:
//   PAID      = a positive claim that money was captured.
//   INITIATED = the ABSENCE of that claim. Not "never paid" — "not confirmed".
//   VOIDED    = cancelled before any capture.
export type TransactionStatus = 'INITIATED' | 'PAID' | 'VOIDED'

// Statuses an order can only reach AFTER its original charge was captured.
// REFUND / PARTIAL_REFUND belong here on purpose: a refund presupposes a payment,
// and the refund itself is a SEPARATE row (transaction_type <> 'ORIGINAL') — this
// value describes the original transaction, which was captured. REOPEN is a
// COMPLETED order reopened, so likewise.
const CAPTURED = new Set(['COMPLETED', 'DUE', 'PAID', 'REOPEN', 'REFUND', 'REFUNDED', 'PARTIAL_REFUND'])

// Cancelled before capture. VOID/VOIDED is the one status that says so outright.
const VOID_STATES = new Set(['VOID', 'VOIDED'])

// Billed and awaiting collection — the native invoice state, and the case that
// exposed the hardcode.
const AWAITING = new Set(['UNPAID', 'RESERVED', 'CART', 'PAYMENT_FAILED'])

/**
 * Derive the payment status of an order's ORIGINAL transaction from the order status.
 *
 * Anything not explicitly listed — including EXPIRED and CANCELED, and any FM
 * status we have not seen — returns INITIATED rather than PAID. That is deliberate
 * and is NOT a default-to-paid in disguise: Disco holds no payment record for
 * FM-backed orders (verified — zero paid_at and effectively zero
 * disco_stripe_payments rows across all 1,064 EXPIRED/CANCELED/REFUND/REOPEN
 * mirror rows), and FM is read-only, so capture cannot be confirmed for them.
 * INITIATED records that absence of confirmation. For a cancelled order that WAS
 * captured this understates rather than overstates, which is the safe direction
 * for a payments record: it never claims money arrived that may not have.
 */
export function transactionStatusForOrder(orderStatus: string | null | undefined): TransactionStatus {
  const s = String(orderStatus || '').trim().toUpperCase()
  if (CAPTURED.has(s)) return 'PAID'
  if (VOID_STATES.has(s)) return 'VOIDED'
  if (AWAITING.has(s)) return 'INITIATED'
  return 'INITIATED'
}

/**
 * The same mapping as a SQL CASE expression over a column, so the one-shot
 * backfill cannot drift from the runtime writers either. `col` must be a trusted
 * identifier — it is interpolated, never user input.
 */
export function transactionStatusSqlCase(col: string): string {
  const list = (vals: Set<string>) => [...vals].map(v => `'${v}'`).join(', ')
  return `CASE
    WHEN UPPER(TRIM(${col})) IN (${list(CAPTURED)}) THEN 'PAID'
    WHEN UPPER(TRIM(${col})) IN (${list(VOID_STATES)}) THEN 'VOIDED'
    ELSE 'INITIATED'
  END`
}
