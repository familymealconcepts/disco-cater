import { sql } from '../db'

// Refund money that went wrong, recorded beside its #ops-alerts post so NM OS's ops watch can raise it
// (noise-machine src/lib/opsWatch.ts). Table: lib/migrations/009_disco_money_failures.sql. Approved by
// Kevin, 2026-10-23.
//
// Written by lib/order/native-refund.ts at the five places it alerts:
//   refund_refused           the restaurant could not fund the reversal; nothing moved
//   payout_not_reversed      the diner was refunded, taking the restaurant's share back failed
//   refund_from_disco_funds  no payout transfer to reverse; Disco's own funds covered it (record only)
//
// Best-effort by rule: a failed write is logged and swallowed, so it never changes, delays or fails a
// refund. No personal data: the order reference, amounts and Stripe's ids and error only.

export type MoneyFailureKind = 'refund_refused' | 'payout_not_reversed' | 'refund_from_disco_funds'
/** Which caller started the refund. refundNativeOrder has four; 'unknown' when a caller did not say. */
export type RefundVia = 'admin_refund' | 'restaurant_refund' | 'order_edit' | 'sold_out_auto_refund' | 'unknown'

export type MoneyFailure = {
  kind: MoneyFailureKind
  via?: RefundVia
  orderReference: string
  refundAmount?: number | null
  neededAmount?: number | null
  heldAmount?: number | null
  stripeTransferId?: string | null
  stripeError?: unknown
}

const dollars = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

/** Stripe's error as stored: its message, at most 300 characters. */
export function storedError(e: unknown): string | null {
  if (e == null) return null
  const msg = e instanceof Error ? e.message : String(e)
  return msg ? msg.slice(0, 300) : null
}

export async function recordMoneyFailure(f: MoneyFailure): Promise<void> {
  if (!f.orderReference) return
  try {
    await sql`
      INSERT INTO disco_money_failures
        (kind, via, order_reference, refund_amount, needed_amount, held_amount, stripe_transfer_id, stripe_error)
      VALUES (${f.kind}, ${f.via ?? 'unknown'}, ${f.orderReference}, ${dollars(f.refundAmount)}, ${dollars(f.neededAmount)},
              ${dollars(f.heldAmount)}, ${f.stripeTransferId ?? null}, ${storedError(f.stripeError)})
    `
  } catch (e) {
    console.error('[money-failures] record failed (non-fatal):', f.kind, f.orderReference, e instanceof Error ? e.message : e)
  }
}
