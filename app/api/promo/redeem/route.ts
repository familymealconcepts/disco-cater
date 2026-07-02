import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runMigrations } from '../../../../lib/db'
import { getRestaurantMoneyFlow, canRestaurantFundedSettle } from '../../../../lib/promo'

export const runtime = 'nodejs'

// POST /api/promo/redeem — called server-side AFTER a successful FM order + Stripe
// charge. Issues the discount as a Stripe refund. Who absorbs it depends on
// funded_by:
//   DISCO      → plain refund off the platform balance; the restaurant keeps its
//                full destination transfer (Disco/platform funds the discount).
//   RESTAURANT → refund WITH reverse_transfer:true, which reverses the discount
//                out of the restaurant's Stripe destination transfer, so the
//                RESTAURANT absorbs it. Only valid under FM moneyFlow=DIRECT (a
//                destination charge exists to reverse); refused otherwise.
// { code, orderRef, restaurantReference, userEmail, discountAmount, stripePaymentIntentId }
export async function POST(req: NextRequest) {
  await runMigrations()

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400 }) }

  const code = String(body.code || '').trim()
  const orderRef = String(body.orderRef || '').trim()
  const restaurantRef = String(body.restaurantReference || body.restaurantRef || '').trim()
  const userEmail = String(body.userEmail || '').trim().toLowerCase()
  const discountAmount = typeof body.discountAmount === 'number' ? body.discountAmount : parseFloat(String(body.discountAmount || 0))
  const stripePaymentIntentId = String(body.stripePaymentIntentId || '').trim()

  if (!code || !orderRef || !discountAmount || discountAmount <= 0) {
    return NextResponse.json({ success: false, error: 'Missing required fields.' }, { status: 400 })
  }

  // (1) look up the code — scoped to this restaurant's own code or a global one,
  // preferring the restaurant-specific match (same as /api/promo/validate).
  const rows = (await sql`
    SELECT id, funded_by, restaurant_ref FROM promo_codes
    WHERE UPPER(code) = UPPER(${code})
      AND (restaurant_ref IS NULL OR restaurant_ref = ${restaurantRef})
    ORDER BY (restaurant_ref IS NOT NULL) DESC, id DESC
    LIMIT 1
  `) as { id: number; funded_by: 'DISCO' | 'RESTAURANT'; restaurant_ref: string | null }[]
  const promo = rows[0]
  if (!promo) return NextResponse.json({ success: false, error: 'Promo code not found.' }, { status: 404 })

  // Restaurant-funded settlement is gated: it reverses funds out of the
  // restaurant's transfer, only safe under DIRECT and once verified. Refuse rather
  // than silently refunding off the platform (which would make Disco eat a
  // restaurant-funded discount).
  const isRestaurantFunded = promo.funded_by === 'RESTAURANT'
  if (isRestaurantFunded) {
    const moneyFlow = await getRestaurantMoneyFlow(promo.restaurant_ref || restaurantRef)
    if (!canRestaurantFundedSettle(moneyFlow)) {
      return NextResponse.json({ success: false, error: 'Restaurant-funded promo settlement is not enabled for this restaurant.' }, { status: 409 })
    }
  }

  // (2) refund the CUSTOMER — identical for both funded types (off the platform
  // balance, no reverse_transfer). Restaurant-funded codes ALSO reverse the
  // discount out of the restaurant's transfer, but that happens LATER via the
  // transfer.created webhook: the destination transfer doesn't exist yet at redeem
  // time, and the refund's reverse_transfer flag would only reverse PROPORTIONALLY
  // (empirically: a $25 refund on a $100 charge reverses just $18.60 of a $74.40
  // transfer). See lib/promo-reversal.ts.
  let refundId: string | null = null
  let refundStatus: 'completed' | 'failed' = 'failed'
  let refundError: string | null = null
  let chargeId: string | null = null
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    refundError = 'STRIPE_SECRET_KEY not configured'
  } else if (!stripePaymentIntentId) {
    refundError = 'Missing stripePaymentIntentId'
  } else {
    try {
      const stripe = new Stripe(stripeKey, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
      const refund = await stripe.refunds.create({
        payment_intent: stripePaymentIntentId,
        amount: Math.round(discountAmount * 100), // dollars → cents
      })
      refundId = refund.id
      refundStatus = 'completed'
      // The charge id is how the transfer.created webhook later matches this
      // pending reversal (transfer.source_transaction === charge).
      chargeId = typeof refund.charge === 'string' ? refund.charge : (refund.charge as { id?: string } | null)?.id ?? null
    } catch (e) {
      refundError = e instanceof Error ? e.message : String(e)
      console.error('[promo/redeem] Stripe refund failed:', refundError)
    }
  }

  // Restaurant-funded: queue the transfer reversal. Only when the customer refund
  // actually succeeded (otherwise there's nothing to offset). The webhook fires
  // the reversal once the destination transfer exists.
  const reversalStatus = isRestaurantFunded && refundStatus === 'completed' ? 'reversal_pending' : null

  // (3) record the use (always — even when the refund failed, the order is placed).
  // For restaurant-funded, stripe_charge_id + reversal_status='reversal_pending'
  // are what the transfer.created webhook matches to fire the transfer reversal.
  try {
    await sql`
      INSERT INTO promo_code_uses (
        promo_code_id, user_email, order_ref, discount_applied, stripe_refund_id, refund_status,
        funded_by, restaurant_ref, stripe_charge_id, stripe_payment_intent_id, reversal_status
      )
      VALUES (
        ${promo.id}, ${userEmail}, ${orderRef}, ${discountAmount}, ${refundId}, ${refundStatus},
        ${promo.funded_by}, ${promo.restaurant_ref}, ${chargeId}, ${stripePaymentIntentId || null}, ${reversalStatus}
      )
    `
    // (4) increment uses_count
    await sql`UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ${promo.id}`
  } catch (e) {
    console.error('[promo/redeem] failed to record use:', e instanceof Error ? e.message : e)
  }

  if (refundStatus === 'completed') {
    return NextResponse.json({ success: true, refundId })
  }
  // Refund failed — do NOT throw; the order is already placed. Surface for ops.
  return NextResponse.json({ success: false, error: refundError || 'Refund failed' })
}
