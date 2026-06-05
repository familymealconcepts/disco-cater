import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../../../lib/db'
import { getCustomer } from '../../../../../../lib/recurring'

export const runtime = 'nodejs'

// PATCH — update a single occurrence belonging to the caller's recurring order.
// Accepts { status: 'SKIPPED' } to skip, { status: 'SCHEDULED' } to restore a
// skipped occurrence, and/or { cartSnapshot } to replace its cart.
const OCC_STATUSES = ['SKIPPED', 'SCHEDULED']
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; occurrenceId: string }> }
) {
  const { id, occurrenceId } = await params
  const customer = await getCustomer()
  if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Ensure the occurrence's recurring order belongs to this customer.
  const owned = (await sql`
    SELECT o.id
    FROM recurring_order_occurrences o
    JOIN recurring_orders r ON r.id = o.recurring_order_id
    WHERE o.id = ${occurrenceId}
      AND o.recurring_order_id = ${id}
      AND r.customer_fm_reference = ${customer.reference}
    LIMIT 1
  `) as { id: string }[]
  if (owned.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const hasStatus = body.status !== undefined
  const hasCart = body.cartSnapshot !== undefined

  if (!hasStatus && !hasCart) {
    return NextResponse.json({ error: "Provide { status: 'SKIPPED' | 'SCHEDULED' } and/or { cartSnapshot }" }, { status: 400 })
  }
  if (hasStatus && !OCC_STATUSES.includes(body.status as string)) {
    return NextResponse.json({ error: "status may only be set to 'SKIPPED' or 'SCHEDULED' here" }, { status: 400 })
  }

  const status = hasStatus ? (body.status as string) : null
  const snapshot = hasCart ? (body.cartSnapshot === null ? null : JSON.stringify(body.cartSnapshot)) : null

  // Apply the requested fields. Skipping stamps canceled_at so the timeline
  // reflects when the customer opted out; restoring to SCHEDULED clears it.
  let updated: unknown[]
  if (status === 'SKIPPED' && hasCart) {
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET status = 'SKIPPED', canceled_at = NOW(), cart_snapshot = ${snapshot}::jsonb, updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  } else if (status === 'SKIPPED') {
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET status = 'SKIPPED', canceled_at = NOW(), updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  } else if (status === 'SCHEDULED' && hasCart) {
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET status = 'SCHEDULED', canceled_at = NULL, cancellation_reason = NULL, cart_snapshot = ${snapshot}::jsonb, updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  } else if (status === 'SCHEDULED') {
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET status = 'SCHEDULED', canceled_at = NULL, cancellation_reason = NULL, updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  } else {
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET cart_snapshot = ${snapshot}::jsonb, updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  }

  return NextResponse.json({ occurrence: updated[0] })
}
