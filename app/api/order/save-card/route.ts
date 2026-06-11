import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

const stripeKey = process.env.STRIPE_SECRET_KEY

// Disco-native saved card vault. Attaches the just-charged PaymentMethod to a
// Stripe customer (keyed by the customer's email) and caches the default in
// disco_customer_payment_methods. Best-effort: called fire-and-forget after the
// order is already placed + paid, so it must NEVER throw or look like a failure
// — always returns 200.
export async function POST(req: NextRequest) {
  try {
    if (!stripeKey) {
      console.warn('[save-card] STRIPE_SECRET_KEY not set — skipping')
      return NextResponse.json({ success: false }, { status: 200 })
    }

    const { paymentMethodId } = await req.json().catch(() => ({}))
    if (!paymentMethodId) return NextResponse.json({ success: false }, { status: 200 })

    // Identify the customer from the FM auth cookie (same self-fetch pattern as
    // the recurring-orders route). Gives us email + reference + name.
    const userRes = await fetch(new URL('/api/fm-user', req.url), {
      headers: { cookie: req.headers.get('cookie') || '' },
    })
    if (!userRes.ok) {
      console.warn('[save-card] could not resolve customer from token:', userRes.status)
      return NextResponse.json({ success: false }, { status: 200 })
    }
    const user = await userRes.json().catch(() => ({}))
    const email: string = user?.email || ''
    if (!email) return NextResponse.json({ success: false }, { status: 200 })
    const fmRef: string | null = user?.reference || null
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()

    const stripe = new Stripe(stripeKey, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])

    // 1. Find or create the Stripe customer for this email.
    const existing = await stripe.customers.list({ email, limit: 1 })
    const customer = existing.data[0] ?? await stripe.customers.create({ email, ...(name ? { name } : {}) })
    const stripeCustomerId = customer.id

    // 2. Attach the payment method and make it the customer default.
    await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId })
    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    })

    // 3. Read back the card details for display.
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    const brand = pm.card?.brand ?? null
    const last4 = pm.card?.last4 ?? null
    const expMonth = pm.card?.exp_month ?? null
    const expYear = pm.card?.exp_year ?? null

    // 4. Upsert into the Disco vault (one default card per customer email).
    await runDiscoOrderMigrations()
    await sql`
      INSERT INTO disco_customer_payment_methods
        (customer_email, fm_user_reference, stripe_customer_id, stripe_payment_method_id,
         card_brand, card_last4, card_exp_month, card_exp_year, is_default, updated_at)
      VALUES
        (${email}, ${fmRef}, ${stripeCustomerId}, ${paymentMethodId},
         ${brand}, ${last4}, ${expMonth}, ${expYear}, true, NOW())
      ON CONFLICT (customer_email) DO UPDATE SET
        fm_user_reference = EXCLUDED.fm_user_reference,
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_payment_method_id = EXCLUDED.stripe_payment_method_id,
        card_brand = EXCLUDED.card_brand,
        card_last4 = EXCLUDED.card_last4,
        card_exp_month = EXCLUDED.card_exp_month,
        card_exp_year = EXCLUDED.card_exp_year,
        is_default = true,
        updated_at = NOW()
    `

    console.log('[save-card] saved card for', email, '—', brand, last4)
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('[save-card] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false }, { status: 200 })
  }
}
