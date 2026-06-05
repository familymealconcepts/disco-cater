import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../../../lib/db'
import { getCustomer } from '../../../../../../lib/recurring'

export const runtime = 'nodejs'

// PATCH — update a single occurrence belonging to the caller's recurring order.
// Accepts { status: 'SKIPPED' } to skip the occurrence, and/or { cartSnapshot }
// to replace its cart.
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
    return NextResponse.json({ error: "Provide { status: 'SKIPPED' } and/or { cartSnapshot }" }, { status: 400 })
  }
  if (hasStatus && body.status !== 'SKIPPED') {
    return NextResponse.json({ error: "status may only be set to 'SKIPPED' here" }, { status: 400 })
  }

  // Apply the requested fields. Skipping also stamps canceled_at so the timeline
  // reflects when the customer opted out.
  let updated: unknown[]
  if (hasStatus && hasCart) {
    const snapshot = body.cartSnapshot === null ? null : JSON.stringify(body.cartSnapshot)
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET status = 'SKIPPED', canceled_at = NOW(), cart_snapshot = ${snapshot}::jsonb, updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  } else if (hasStatus) {
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET status = 'SKIPPED', canceled_at = NOW(), updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  } else {
    const snapshot = body.cartSnapshot === null ? null : JSON.stringify(body.cartSnapshot)
    updated = (await sql`
      UPDATE recurring_order_occurrences
      SET cart_snapshot = ${snapshot}::jsonb, updated_at = NOW()
      WHERE id = ${occurrenceId}
      RETURNING *
    `) as unknown[]
  }

  return NextResponse.json({ occurrence: updated[0] })
}
