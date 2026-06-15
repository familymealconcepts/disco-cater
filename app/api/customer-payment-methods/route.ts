import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runCustomerPaymentMethodMigrations } from '../../../lib/db'
import { getCustomer } from '../../../lib/recurring'

export const runtime = 'nodejs'

function stripeClient() {
  return new Stripe(
    process.env.STRIPE_SECRET_KEY || '',
    { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1],
  )
}

interface CardRow {
  id: number
  card_brand: string | null
  card_last4: string | null
  card_exp_month: number | null
  card_exp_year: number | null
  is_default: boolean
  stripe_customer_id?: string | null
}

function mapCard(r: CardRow) {
  return {
    id: r.id,
    brand: r.card_brand,
    last4: r.card_last4,
    expMonth: r.card_exp_month,
    expYear: r.card_exp_year,
    isDefault: r.is_default,
  }
}

// GET — all vaulted cards for the logged-in customer, default first.
export async function GET() {
  try {
    const customer = await getCustomer()
    if (!customer?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    try { await runCustomerPaymentMethodMigrations() } catch (e) { console.error('[card-vault] migration warning (non-fatal):', e) }

    const rows = (await sql`
      SELECT id, card_brand, card_last4, card_exp_month, card_exp_year, is_default
      FROM disco_customer_payment_methods
      WHERE customer_email = ${customer.email}
      ORDER BY is_default DESC, created_at DESC
    `) as CardRow[]

    return NextResponse.json({ cards: rows.map(mapCard) })
  } catch (err) {
    console.error('[card-vault GET]', err)
    return NextResponse.json({ error: 'Could not load payment methods' }, { status: 500 })
  }
}

// POST — vault a new card. The client tokenizes via Stripe Elements
// (createPaymentMethod) and sends the resulting paymentMethodId; we attach it to
// the customer's Stripe customer and store the card metadata. The first card (or
// when there's no existing default) becomes the default.
export async function POST(req: NextRequest) {
  try {
    const customer = await getCustomer()
    if (!customer?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    try { await runCustomerPaymentMethodMigrations() } catch (e) { console.error('[card-vault] migration warning (non-fatal):', e) }

    let body: Record<string, unknown>
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    const paymentMethodId = String(body?.paymentMethodId || '').trim()
    if (!paymentMethodId) return NextResponse.json({ error: 'paymentMethodId is required' }, { status: 400 })

    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 })
    }
    const stripe = stripeClient()

    // Reuse the customer's existing Stripe customer (all their cards live under
    // one), else create one keyed by email.
    const existing = (await sql`
      SELECT stripe_customer_id FROM disco_customer_payment_methods
      WHERE customer_email = ${customer.email} AND stripe_customer_id IS NOT NULL
      LIMIT 1
    `) as { stripe_customer_id: string }[]
    let stripeCustomerId = existing[0]?.stripe_customer_id
    if (!stripeCustomerId) {
      const c = await stripe.customers.create({ email: customer.email })
      stripeCustomerId = c.id
    }

    await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId })
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    const card = pm.card

    // Default only when the customer has no default yet.
    const hasDefault = (await sql`
      SELECT 1 FROM disco_customer_payment_methods WHERE customer_email = ${customer.email} AND is_default = true LIMIT 1
    `) as unknown[]
    const isDefault = hasDefault.length === 0
    if (isDefault) {
      await sql`UPDATE disco_customer_payment_methods SET is_default = false WHERE customer_email = ${customer.email}`
    }

    const inserted = (await sql`
      INSERT INTO disco_customer_payment_methods (
        customer_email, fm_user_reference, stripe_customer_id, stripe_payment_method_id,
        card_brand, card_last4, card_exp_month, card_exp_year, is_default
      ) VALUES (
        ${customer.email}, ${customer.reference || null}, ${stripeCustomerId}, ${paymentMethodId},
        ${card?.brand ?? null}, ${card?.last4 ?? null}, ${card?.exp_month ?? null}, ${card?.exp_year ?? null}, ${isDefault}
      )
      RETURNING id, card_brand, card_last4, card_exp_month, card_exp_year, is_default
    `) as CardRow[]

    return NextResponse.json({ card: mapCard(inserted[0]) }, { status: 201 })
  } catch (err) {
    console.error('[card-vault POST]', err)
    const message = err instanceof Stripe.errors.StripeError ? err.message : 'Could not save card'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
