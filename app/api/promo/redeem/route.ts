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

  // ── EVERY NUMBER HERE IS DECIDED BY THE SERVER (22 Oct 2026) ─────────────
  // This route is unauthenticated (it runs right after an FM-backed checkout)
  // and used to refund WHATEVER discountAmount, on WHATEVER PaymentIntent, the
  // body named — for any DISCO-funded code, active or not. That was a refund
  // of up to the full charge on any platform payment, by anyone. Now:
  //   - the code must be DISCO-funded, active, in its date window, under its
  //     use limit;
  //   - the PaymentIntent must exist on the platform, have succeeded, and be
  //     recent (2 hours) — the checkout calls this seconds after the charge;
  //   - one redemption per PaymentIntent and per order;
  //   - the refund is capped at the code's own percentage of that charge.
  // A legitimate redemption (none has ever happened: 0 DISCO-funded uses) is
  // unaffected; anything else refunds nothing.
  const rows = (await sql`
    SELECT id, funded_by, discount_value, discount_type, max_discount_cap, valid_from, valid_until, active, max_uses, uses_count
    FROM promo_codes
    WHERE UPPER(code) = UPPER(${code})
      AND (restaurant_ref IS NULL OR restaurant_ref = ${restaurantRef})
    ORDER BY (restaurant_ref IS NOT NULL) DESC, id DESC
    LIMIT 1
  `) as Array<{ id: number; funded_by: 'DISCO' | 'RESTAURANT'; discount_value: string | number; discount_type: string; max_discount_cap: string | number | null; valid_from: string | null; valid_until: string | null; active: boolean; max_uses: number | null; uses_count: number }>
  const promo = rows[0]
  if (!promo) return NextResponse.json({ success: false, error: 'Promo code not found.' }, { status: 404 })

  // Restaurant-funded codes are settled pre-charge in /api/order/place, never here.
  // Refuse rather than issue a platform refund (which would make Disco eat it).
  if (promo.funded_by === 'RESTAURANT') {
    return NextResponse.json({ success: false, error: 'Restaurant-funded codes are applied at checkout, not refunded.' }, { status: 409 })
  }
  const now = Date.now()
  if (!promo.active
    || (promo.valid_from && new Date(promo.valid_from).getTime() > now)
    || (promo.valid_until && new Date(promo.valid_until).getTime() < now)
    || (promo.max_uses != null && promo.uses_count >= promo.max_uses)) {
    return NextResponse.json({ success: false, error: 'This promo code is not active.' }, { status: 409 })
  }
  if (!stripePaymentIntentId) return NextResponse.json({ success: false, error: 'Missing stripePaymentIntentId' }, { status: 400 })
  const dupe = (await sql`
    SELECT 1 FROM promo_code_uses WHERE stripe_payment_intent_id = ${stripePaymentIntentId} OR order_ref = ${orderRef} LIMIT 1
  `) as unknown[]
  if (dupe.length) return NextResponse.json({ success: false, error: 'Already redeemed.' }, { status: 409 })

  let refundId: string | null = null
  let refundStatus: 'completed' | 'failed' = 'failed'
  let refundError: string | null = null
  let applied = 0
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    refundError = 'STRIPE_SECRET_KEY not configured'
  } else {
    try {
      const stripe = new Stripe(stripeKey, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
      const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId)
      const ageMs = now - (pi.created || 0) * 1000
      if (pi.status !== 'succeeded' || ageMs > 2 * 60 * 60 * 1000) {
        return NextResponse.json({ success: false, error: 'This payment cannot be discounted.' }, { status: 409 })
      }
      const chargedCents = pi.amount_received || pi.amount || 0
      const value = Number(promo.discount_value) || 0
      const capByCode = promo.discount_type === 'flat'
        ? Math.round(value * 100)
        : Math.round(chargedCents * Math.min(Math.max(value, 0), 100) / 100)
      const capByMax = promo.max_discount_cap == null ? Infinity : Math.round(Number(promo.max_discount_cap) * 100)
      const cents = Math.max(0, Math.min(Math.round(discountAmount * 100), capByCode, capByMax, chargedCents))
      if (!cents) return NextResponse.json({ success: false, error: 'Nothing to refund.' }, { status: 409 })
      const refund = await stripe.refunds.create({ payment_intent: stripePaymentIntentId, amount: cents })
      refundId = refund.id
      refundStatus = 'completed'
      applied = cents / 100
    } catch (e) {
      refundError = e instanceof Error ? e.message : String(e)
      console.error('[promo/redeem] Stripe refund failed:', refundError)
    }
  }

  // (3) record the use + increment the counter (always — the order is placed).
  try {
    await sql`
      INSERT INTO promo_code_uses (promo_code_id, user_email, order_ref, discount_applied, stripe_refund_id, refund_status, funded_by, stripe_payment_intent_id)
      VALUES (${promo.id}, ${userEmail}, ${orderRef}, ${applied}, ${refundId}, ${refundStatus}, 'DISCO', ${stripePaymentIntentId || null})
    `
    await sql`UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ${promo.id}`
  } catch (e) {
    console.error('[promo/redeem] failed to record use:', e instanceof Error ? e.message : e)
  }

  if (refundStatus === 'completed') return NextResponse.json({ success: true, refundId })
  return NextResponse.json({ success: false, error: refundError || 'Refund failed' })
}
