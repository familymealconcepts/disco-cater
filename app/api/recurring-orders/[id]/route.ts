import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getCustomer, extractStripeIds } from '../../../../lib/recurring'

export const runtime = 'nodejs'

// Confirm the recurring order exists and belongs to the caller. Returns the row
// or null.
async function ownedOrder(id: string, customerRef: string) {
  const rows = (await sql`
    SELECT * FROM recurring_orders
    WHERE id = ${id} AND customer_fm_reference = ${customerRef}
    LIMIT 1
  `) as Record<string, unknown>[]
  return rows[0] ?? null
}

// GET — one recurring order with all of its occurrences (ascending by date).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const customer = await getCustomer()
  if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const order = await ownedOrder(id, customer.reference)
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const occurrences = (await sql`
    SELECT * FROM recurring_order_occurrences
    WHERE recurring_order_id = ${id}
    ORDER BY scheduled_date ASC
  `) as unknown[]

  return NextResponse.json({ recurringOrder: { ...order, occurrences } })
}

// PATCH — either update the recurring order's status, or update one occurrence's
// cart snapshot (when { occurrenceId, cartSnapshot } is supplied).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const customer = await getCustomer()
  if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const order = await ownedOrder(id, customer.reference)
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Refresh the saved Stripe payment method from the diner's current default
  // card (used by the "Update payment method" action after a failed charge).
  if (body.refreshPayment === true) {
    let source: unknown = null
    try {
      const psRes = await fetch(new URL('/api/fm-payment-source', req.url), {
        headers: { cookie: req.headers.get('cookie') || '' },
      })
      if (psRes.ok) source = await psRes.json()
    } catch (e) {
      console.warn('[recurring-orders PATCH] could not fetch payment source:', e)
    }
    const { stripeCustomerId, stripePaymentMethodId } = extractStripeIds(source)
    if (!stripePaymentMethodId) {
      return NextResponse.json({ error: 'No saved payment method found. Please add a card in Payment settings first.' }, { status: 400 })
    }
    const updated = (await sql`
      UPDATE recurring_orders
      SET stripe_customer_id = ${stripeCustomerId}, stripe_payment_method_id = ${stripePaymentMethodId}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `) as unknown[]
    return NextResponse.json({ recurringOrder: updated[0] })
  }

  // Update a specific occurrence's cart.
  if (body.occurrenceId !== undefined) {
    const occurrenceId = body.occurrenceId as string
    const snapshot = body.cartSnapshot === undefined || body.cartSnapshot === null ? null : JSON.stringify(body.cartSnapshot)
    const updated = (await sql`
      UPDATE recurring_order_occurrences
      SET cart_snapshot = ${snapshot}::jsonb, updated_at = NOW()
      WHERE id = ${occurrenceId} AND recurring_order_id = ${id}
      RETURNING *
    `) as unknown[]
    if (updated.length === 0) return NextResponse.json({ error: 'Occurrence not found' }, { status: 404 })
    return NextResponse.json({ occurrence: updated[0] })
  }

  // Update the recurring order's status.
  if (body.status !== undefined) {
    const status = body.status as string
    if (status !== 'ACTIVE' && status !== 'PAUSED' && status !== 'CANCELED') {
      return NextResponse.json({ error: 'status must be ACTIVE, PAUSED or CANCELED' }, { status: 400 })
    }
    const updated = (await sql`
      UPDATE recurring_orders
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `) as unknown[]
    return NextResponse.json({ recurringOrder: updated[0] })
  }

  // Update the cart for every FUTURE occurrence (the "update all future orders"
  // path from the cart editor). Already-placed/canceled/skipped and past
  // occurrences are left untouched.
  if (body.cartSnapshot !== undefined) {
    const snapshot = body.cartSnapshot === null ? null : JSON.stringify(body.cartSnapshot)
    const updated = (await sql`
      UPDATE recurring_order_occurrences
      SET cart_snapshot = ${snapshot}::jsonb, updated_at = NOW()
      WHERE recurring_order_id = ${id}
        AND scheduled_date >= CURRENT_DATE
        AND status NOT IN ('PLACED', 'CANCELED', 'SKIPPED')
      RETURNING id
    `) as { id: string }[]
    return NextResponse.json({ updatedOccurrences: updated.length })
  }

  return NextResponse.json({ error: 'Nothing to update — provide { status }, { cartSnapshot }, or { occurrenceId, cartSnapshot }' }, { status: 400 })
}

// DELETE — cancel the recurring order: mark it CANCELED and cancel every
// still-scheduled occurrence.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const customer = await getCustomer()
  if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const order = await ownedOrder(id, customer.reference)
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await sql`
    UPDATE recurring_orders
    SET status = 'CANCELED', updated_at = NOW()
    WHERE id = ${id}
  `
  await sql`
    UPDATE recurring_order_occurrences
    SET status = 'CANCELED', canceled_at = NOW(), updated_at = NOW()
    WHERE recurring_order_id = ${id} AND status = 'SCHEDULED'
  `

  return NextResponse.json({ ok: true })
}
