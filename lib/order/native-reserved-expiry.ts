// Native checkout writes RESERVED at order-creation time and only ever
// transitions RESERVED→DUE on a Stripe payment_intent.succeeded webhook —
// there is no failure path and no expiry job. Confirmed real (2026-08-14):
// 5 native orders sat in RESERVED, one 485 hours old. FM's own equivalent
// (RestaurantOrderExpireTaskRunnable) flips RESERVED→EXPIRED after 5 minutes,
// but 5 minutes is tuned for FM's slot-selection flow, not a card payment —
// Stripe's own 3D Secure / bank-verification redirects can legitimately run
// past that. This sweep uses a longer default and, critically, verifies the
// REAL Stripe state before ever calling an order abandoned: checking those
// same 5 real orders found 2 had ALREADY succeeded in Stripe (a webhook that
// never arrived or failed) — expiring by age alone would have silently
// buried two paid orders as "abandoned," never notifying the restaurant,
// never fulfilling them, and never refunding the customer either. A stale
// RESERVED order is reconciled to DUE (via the same complete path the
// webhook uses) or genuinely expired — never blindly timed out.
import Stripe from 'stripe'
import { sql } from '../db'
import { handleNativePaymentIntentSucceeded, recordOrderEvent } from './native-payment-succeeded'
import { releaseNativeRestaurantPromoUse } from '../promo-native'

export const DEFAULT_RESERVED_EXPIRY_MINUTES = 30

export interface ReservedExpirySummary {
  checked: number
  reconciled: number   // found actually succeeded in Stripe — flipped to DUE via the normal path
  expired: number       // genuinely dead — flipped to EXPIRED, any promo reservation released
  skipped: number       // still in-flight (processing) or couldn't be checked — left RESERVED
  details: Array<{ orderNumber: string | number; reference: string; outcome: string; reason: string }>
}

interface StaleReservedRow {
  id: number
  reference: string
  order_number: string | number
  created_at: string
  payment_intent_id: string | null
}

// Every promo use tied to this order (normally 0 or 1 — reserveNativeRestaurantPromoUse
// is called once per checkout) gets its cap slot given back. finalizeNativeRestaurantPromoUse
// runs right after the order+PaymentIntent are CREATED, not after payment confirms, so an
// abandoned checkout's promo_code_uses row is already real (not the placeholder), pointing
// at this exact order_ref — confirmed live: order #900000077's promo (id 14) was permanently
// consumed this way before this sweep existed.
async function releasePromoForOrder(orderReference: string): Promise<number> {
  const uses = (await sql`
    SELECT id, promo_code_id FROM promo_code_uses WHERE order_ref = ${orderReference}
  `) as { id: number; promo_code_id: number }[]
  for (const u of uses) await releaseNativeRestaurantPromoUse(u.id, u.promo_code_id)
  return uses.length
}

export async function expireStaleNativeReservedOrders(
  stripe: Stripe,
  minutes: number = DEFAULT_RESERVED_EXPIRY_MINUTES,
): Promise<ReservedExpirySummary> {
  const summary: ReservedExpirySummary = { checked: 0, reconciled: 0, expired: 0, skipped: 0, details: [] }

  const rows = (await sql`
    SELECT o.id, o.reference::text AS reference, o.order_number, o.created_at::text AS created_at,
           COALESCE(sp.stripe_payment_intent_id, st.stripe_payment_intent_id) AS payment_intent_id
    FROM disco_orders o
    LEFT JOIN disco_stripe_payments sp ON sp.order_reference = o.reference
    LEFT JOIN disco_sale_transactions st ON st.order_id = o.id AND st.transaction_type = 'ORIGINAL'
    WHERE o.fm_order_reference IS NULL
      AND o.order_status = 'RESERVED'
      AND o.is_deleted = false
      AND o.created_at < NOW() - make_interval(mins => ${minutes})
    ORDER BY o.created_at ASC
  `) as StaleReservedRow[]

  summary.checked = rows.length

  for (const row of rows) {
    const label = { orderNumber: row.order_number, reference: row.reference }

    // No PaymentIntent on record at all (shouldn't happen for the card path —
    // the invoice path (M7) never uses RESERVED, it places UNPAID directly).
    // Can't safely determine truth without one — leave it RESERVED for a
    // human to look at rather than guess.
    if (!row.payment_intent_id) {
      summary.skipped++
      summary.details.push({ ...label, outcome: 'skipped', reason: 'no Stripe PaymentIntent on record — cannot verify, left RESERVED' })
      console.warn(`[native-reserved-expiry] order ${row.order_number} (${row.reference}) has no payment_intent_id — skipping`)
      continue
    }

    let pi: Stripe.PaymentIntent
    try {
      pi = await stripe.paymentIntents.retrieve(row.payment_intent_id)
    } catch (e) {
      summary.skipped++
      const reason = `Stripe retrieve failed: ${e instanceof Error ? e.message : e}`
      summary.details.push({ ...label, outcome: 'skipped', reason })
      console.error(`[native-reserved-expiry] order ${row.order_number} (${row.reference}) — ${reason}`)
      continue
    }

    if (pi.status === 'succeeded') {
      // The webhook missed this one (or failed) — reconcile via the exact
      // same complete path (inventory decrement, confirmations, dispatch),
      // never a partial re-implementation.
      try {
        await handleNativePaymentIntentSucceeded(pi, stripe, 'RESERVED_EXPIRY_SWEEP')
        summary.reconciled++
        summary.details.push({ ...label, outcome: 'reconciled', reason: `Stripe PI ${pi.id} had already succeeded — flipped to DUE (webhook likely missed this order)` })
        console.warn(`[native-reserved-expiry] RECOVERED a stuck-paid order: ${row.order_number} (${row.reference}), PI ${pi.id} succeeded but order was still RESERVED`)
      } catch (e) {
        summary.skipped++
        const reason = `reconciliation threw: ${e instanceof Error ? e.message : e}`
        summary.details.push({ ...label, outcome: 'skipped', reason })
        console.error(`[native-reserved-expiry] order ${row.order_number} (${row.reference}) — ${reason}`)
      }
      continue
    }

    if (pi.status === 'processing') {
      // A legitimate in-flight payment (e.g. a bank-debit method) that can
      // still resolve — never expire a live attempt out from under it.
      summary.skipped++
      summary.details.push({ ...label, outcome: 'skipped', reason: `Stripe PI ${pi.id} is still processing — left RESERVED` })
      continue
    }

    // Anything else (requires_payment_method, requires_confirmation,
    // requires_action, requires_capture, canceled) — the customer never
    // completed the charge. Genuinely dead.
    await sql`UPDATE disco_orders SET order_status = 'EXPIRED', updated_at = NOW() WHERE id = ${row.id}`
    const releasedPromos = await releasePromoForOrder(row.reference)
    await recordOrderEvent(row.reference, 'RESERVED_EXPIRED', {
      paymentIntentId: pi.id, paymentIntentStatus: pi.status, ageMinutes: minutes, promoUsesReleased: releasedPromos,
    }, 'RESERVED_EXPIRY_SWEEP')
    summary.expired++
    summary.details.push({
      ...label, outcome: 'expired',
      reason: `Stripe PI ${pi.id} status "${pi.status}" — never completed${releasedPromos ? `; released ${releasedPromos} promo use(s)` : ''}`,
    })
    console.log(`[native-reserved-expiry] expired order ${row.order_number} (${row.reference}) — PI ${pi.id} status ${pi.status}${releasedPromos ? `, released ${releasedPromos} promo use(s)` : ''}`)
  }

  return summary
}
