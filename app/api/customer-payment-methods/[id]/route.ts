import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runCustomerPaymentMethodMigrations } from '../../../../lib/db'
import { getCustomer } from '../../../../lib/recurring'

export const runtime = 'nodejs'

// DELETE — remove a vaulted card: detach it from Stripe (best-effort) and delete
// the row. If it was the default, promote the newest remaining card.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const customer = await getCustomer()
    if (!customer?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    try { await runCustomerPaymentMethodMigrations() } catch (e) { console.error('[card-vault] migration warning (non-fatal):', e) }

    const { id } = await params
    const cardId = Number(id)
    if (!Number.isInteger(cardId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    const rows = (await sql`
      SELECT stripe_payment_method_id, is_default FROM disco_customer_payment_methods
      WHERE id = ${cardId} AND customer_email = ${customer.email} LIMIT 1
    `) as { stripe_payment_method_id: string; is_default: boolean }[]
    if (!rows.length) return NextResponse.json({ error: 'Card not found' }, { status: 404 })

    // Best-effort Stripe detach — never block the delete on it.
    if (process.env.STRIPE_SECRET_KEY && rows[0].stripe_payment_method_id) {
      try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
        await stripe.paymentMethods.detach(rows[0].stripe_payment_method_id)
      } catch (e) { console.error('[card-vault DELETE] stripe detach failed:', e instanceof Error ? e.message : e) }
    }

    await sql`DELETE FROM disco_customer_payment_methods WHERE id = ${cardId} AND customer_email = ${customer.email}`

    if (rows[0].is_default) {
      const next = (await sql`
        SELECT id FROM disco_customer_payment_methods WHERE customer_email = ${customer.email}
        ORDER BY created_at DESC LIMIT 1
      `) as { id: number }[]
      if (next.length) await sql`UPDATE disco_customer_payment_methods SET is_default = true WHERE id = ${next[0].id}`
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[card-vault DELETE]', err)
    return NextResponse.json({ error: 'Could not delete card' }, { status: 500 })
  }
}
