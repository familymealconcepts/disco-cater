import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runMigrations } from '../../../../lib/db'
import { processTransferReversal } from '../../../../lib/promo-reversal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// ─────────────────────────────────────────────────────────────────────────────
// Safety-net sweep for restaurant-funded promo reversals.
//
// The happy path is the transfer.created webhook (fires ~9s after the charge),
// which reverses the discount out of the restaurant's transfer. This cron catches
// the cases where that webhook was missed/dropped: any promo_code_uses row still
// 'reversal_pending' after SWEEP_AFTER_MIN gets its transfer looked up (by charge)
// and reversed via the SAME idempotent path (lib/promo-reversal). If the transfer
// still can't be found/completed past HARD_CUTOFF_MIN, the row is marked
// 'reversal_failed' — loud + a PROMO_REVERSAL_FAILED event — never left silent.
//
// Idempotent with the webhook: processTransferReversal only acts on 'reversal_
// pending' rows and uses a Stripe idempotency key, so the cron and a late webhook
// can never double-reverse. Auth: `Authorization: Bearer ${CRON_SECRET}`.
// ─────────────────────────────────────────────────────────────────────────────

const SWEEP_AFTER_MIN = 15   // only touch rows older than this (webhook fires ~9s)
const HARD_CUTOFF_MIN = 120  // past this with no transfer → give up, flag as failed

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

async function recordEvent(orderRef: string | null, eventType: string, data: unknown): Promise<void> {
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    VALUES (${orderRef}::uuid, ${eventType}, ${JSON.stringify(data)}::jsonb, ${'PROMO_REVERSAL_CRON'})
  `.catch(() => {})
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await runMigrations().catch(() => {})

  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) return NextResponse.json({ error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 })
  const stripe = new Stripe(stripeKey, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])

  // Pending reversals old enough that the webhook should already have fired.
  const rows = (await sql`
    SELECT id, order_ref, restaurant_ref, stripe_charge_id, discount_applied,
           EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 AS age_min
    FROM promo_code_uses
    WHERE reversal_status = 'reversal_pending'
      AND stripe_charge_id IS NOT NULL
      AND created_at < NOW() - (${SWEEP_AFTER_MIN} || ' minutes')::interval
    ORDER BY created_at ASC
    LIMIT 200
  `) as { id: number; order_ref: string; restaurant_ref: string | null; stripe_charge_id: string; discount_applied: string | number; age_min: number }[]

  let reversed = 0, failed = 0, stillWaiting = 0, gaveUp = 0
  for (const r of rows) {
    try {
      // Find the destination transfer for this charge.
      const charge = await stripe.charges.retrieve(r.stripe_charge_id)
      const transferId = typeof charge.transfer === 'string' ? charge.transfer : charge.transfer?.id
      if (!transferId) {
        if (r.age_min >= HARD_CUTOFF_MIN) {
          // No transfer after the hard cutoff — the restaurant was never debited and
          // we can't reverse. Flag loudly rather than leave it pending forever.
          await sql`UPDATE promo_code_uses SET reversal_status = 'reversal_failed' WHERE id = ${r.id}`
          console.error(`[cron/promo-reversals] GAVE UP — no transfer after ${Math.round(r.age_min)}min. use=${r.id} order=${r.order_ref} restaurant=${r.restaurant_ref} charge=${r.stripe_charge_id}`)
          await recordEvent(null, 'PROMO_REVERSAL_FAILED', { reason: 'no_transfer_after_cutoff', useId: r.id, orderRef: r.order_ref, chargeId: r.stripe_charge_id, ageMin: Math.round(r.age_min) })
          gaveUp++
        } else {
          stillWaiting++
        }
        continue
      }
      // Transfer exists — run the exact same reversal path as the webhook.
      const transfer = await stripe.transfers.retrieve(transferId)
      const res = await processTransferReversal(stripe, transfer)
      if (res.matched && res.reversed) {
        console.log(`[cron/promo-reversals] reversed via sweep: use=${res.useId} order=${res.orderRef} $${((res.amountCents ?? 0) / 100).toFixed(2)} reversal=${res.reversalId}`)
        await recordEvent(null, 'PROMO_TRANSFER_REVERSED', { via: 'cron', useId: res.useId, orderRef: res.orderRef, amountCents: res.amountCents, reversalId: res.reversalId })
        reversed++
      } else if (res.matched && !res.reversed) {
        console.error(`[cron/promo-reversals] reversal FAILED: use=${res.useId} order=${res.orderRef} error=${res.error}`)
        await recordEvent(null, 'PROMO_REVERSAL_FAILED', { via: 'cron', useId: res.useId, orderRef: res.orderRef, amountCents: res.amountCents, error: res.error })
        failed++
      } else {
        // Not matched — another delivery already handled it. Nothing to do.
        stillWaiting++
      }
    } catch (e) {
      console.error(`[cron/promo-reversals] error processing use=${r.id}:`, e instanceof Error ? e.message : e)
      failed++
    }
  }

  const summary = { scanned: rows.length, reversed, failed, gaveUp, stillWaiting }
  console.log('[cron/promo-reversals]', JSON.stringify(summary))
  return NextResponse.json({ ok: true, ...summary })
}
