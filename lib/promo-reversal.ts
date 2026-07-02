import type Stripe from 'stripe'
import { sql } from './db'

export interface ReversalResult {
  matched: boolean
  reversed?: boolean
  reversalId?: string
  amountCents?: number
  useId?: number
  orderRef?: string
  error?: string
}

// Given a Stripe Transfer (from a `transfer.created` webhook), find a pending
// restaurant-funded promo reversal for that charge and reverse the FULL discount
// out of the restaurant's transfer — so the RESTAURANT absorbs it. This runs
// post-charge because the destination transfer only exists a few seconds after
// the charge settles (verified: transfer.created fires ~9s in).
//
// Correctness notes:
//  - Matches by stripe_charge_id = transfer.source_transaction.
//  - Reverses the EXACT discount amount via transfers.createReversal — NOT the
//    refund's reverse_transfer flag, which reverses only PROPORTIONALLY.
//  - Idempotent against Stripe webhook redelivery: the pending→reversed status
//    transition means a redelivered event finds no pending row and no-ops; and
//    even if two deliveries race before the UPDATE, the idempotencyKey guarantees
//    Stripe creates the reversal exactly once.
//  - A reversal FAILURE is never swallowed: status → 'reversal_failed', logged
//    loudly, and surfaced by the caller as a PROMO_REVERSAL_FAILED event.
export async function processTransferReversal(stripe: Stripe, transfer: Stripe.Transfer): Promise<ReversalResult> {
  const src = transfer.source_transaction
  const chargeId = typeof src === 'string' ? src : src?.id || null
  if (!chargeId) return { matched: false }

  const rows = (await sql`
    SELECT id, discount_applied, order_ref, restaurant_ref
    FROM promo_code_uses
    WHERE stripe_charge_id = ${chargeId} AND reversal_status = 'reversal_pending'
    LIMIT 1
  `) as { id: number; discount_applied: string | number; order_ref: string; restaurant_ref: string | null }[]
  const rec = rows[0]
  if (!rec) return { matched: false }

  const amountCents = Math.round(Number(rec.discount_applied) * 100)
  try {
    const reversal = await stripe.transfers.createReversal(
      transfer.id,
      { amount: amountCents },
      { idempotencyKey: `promo-reversal-${rec.id}` },
    )
    await sql`UPDATE promo_code_uses SET reversal_status = 'reversed', stripe_reversal_id = ${reversal.id} WHERE id = ${rec.id}`
    return { matched: true, reversed: true, reversalId: reversal.id, amountCents, useId: rec.id, orderRef: rec.order_ref }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Money did NOT move off the restaurant — flag it, don't hide it.
    await sql`UPDATE promo_code_uses SET reversal_status = 'reversal_failed' WHERE id = ${rec.id}`.catch(() => {})
    console.error(`[promo-reversal] FAILED — restaurant NOT debited. use=${rec.id} order=${rec.order_ref} restaurant=${rec.restaurant_ref} amount=${amountCents}c transfer=${transfer.id}: ${msg}`)
    return { matched: true, reversed: false, amountCents, useId: rec.id, orderRef: rec.order_ref, error: msg }
  }
}
