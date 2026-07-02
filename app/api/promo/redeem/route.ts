import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

// POST /api/promo/redeem — DISCO-FUNDED codes only. Called server-side AFTER a
// successful FM order + Stripe charge; issues the discount as a plain Stripe
// refund off the PLATFORM balance (the restaurant keeps its full payment — Disco
// funds the discount). Restaurant-funded codes do NOT use this path: they discount
// the subtotal pre-charge in /api/order/place (see lib/promo-apply.ts) — no refund.
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

  // (1) look up the code — restaurant-specific match preferred, else global.
  const rows = (await sql`
    SELECT id, funded_by FROM promo_codes
    WHERE UPPER(code) = UPPER(${code})
      AND (restaurant_ref IS NULL OR restaurant_ref = ${restaurantRef})
    ORDER BY (restaurant_ref IS NOT NULL) DESC, id DESC
    LIMIT 1
  `) as { id: number; funded_by: 'DISCO' | 'RESTAURANT' }[]
  const promo = rows[0]
  if (!promo) return NextResponse.json({ success: false, error: 'Promo code not found.' }, { status: 404 })

  // Restaurant-funded codes are settled pre-charge in /api/order/place, never here.
  // Refuse rather than issue a platform refund (which would make Disco eat it).
  if (promo.funded_by === 'RESTAURANT') {
    return NextResponse.json({ success: false, error: 'Restaurant-funded codes are applied at checkout, not refunded.' }, { status: 409 })
  }

  // (2) refund the customer off the platform balance (Disco funds it).
  let refundId: string | null = null
  let refundStatus: 'completed' | 'failed' = 'failed'
  let refundError: string | null = null
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
    } catch (e) {
      refundError = e instanceof Error ? e.message : String(e)
      console.error('[promo/redeem] Stripe refund failed:', refundError)
    }
  }

  // (3) record the use + increment the counter (always — the order is placed).
  try {
    await sql`
      INSERT INTO promo_code_uses (promo_code_id, user_email, order_ref, discount_applied, stripe_refund_id, refund_status, funded_by, stripe_payment_intent_id)
      VALUES (${promo.id}, ${userEmail}, ${orderRef}, ${discountAmount}, ${refundId}, ${refundStatus}, 'DISCO', ${stripePaymentIntentId || null})
    `
    await sql`UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ${promo.id}`
  } catch (e) {
    console.error('[promo/redeem] failed to record use:', e instanceof Error ? e.message : e)
  }

  if (refundStatus === 'completed') return NextResponse.json({ success: true, refundId })
  return NextResponse.json({ success: false, error: refundError || 'Refund failed' })
}
