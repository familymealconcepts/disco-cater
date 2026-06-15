import { NextRequest, NextResponse } from 'next/server'
import { sql, runCustomerPaymentMethodMigrations } from '../../../../../lib/db'
import { getCustomer } from '../../../../../lib/recurring'

export const runtime = 'nodejs'

// PATCH — make this card the customer's default (unsets the others).
export async function PATCH(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const customer = await getCustomer()
    if (!customer?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    try { await runCustomerPaymentMethodMigrations() } catch (e) { console.error('[card-vault] migration warning (non-fatal):', e) }

    const { id } = await params
    const cardId = Number(id)
    if (!Number.isInteger(cardId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    const owned = (await sql`
      SELECT id FROM disco_customer_payment_methods WHERE id = ${cardId} AND customer_email = ${customer.email} LIMIT 1
    `) as { id: number }[]
    if (!owned.length) return NextResponse.json({ error: 'Card not found' }, { status: 404 })

    await sql`UPDATE disco_customer_payment_methods SET is_default = false WHERE customer_email = ${customer.email}`
    await sql`UPDATE disco_customer_payment_methods SET is_default = true, updated_at = NOW() WHERE id = ${cardId}`

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[card-vault PATCH default]', err)
    return NextResponse.json({ error: 'Could not set default card' }, { status: 500 })
  }
}
