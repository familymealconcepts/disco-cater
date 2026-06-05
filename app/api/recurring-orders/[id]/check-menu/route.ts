import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../../lib/db'
import { getCustomer, checkMenuAvailability, type CartItem } from '../../../../../lib/recurring'

export const runtime = 'nodejs'

// POST — check whether every item in this recurring order's cart is still on the
// restaurant's current FM menu. If anything is missing, pause the order and
// report the missing items.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const customer = await getCustomer()
  if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const rows = (await sql`
    SELECT id, restaurant_reference
    FROM recurring_orders
    WHERE id = ${id} AND customer_fm_reference = ${customer.reference}
    LIMIT 1
  `) as { id: string; restaurant_reference: string }[]
  const order = rows[0]
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The cart lives on the occurrences — use the earliest one that has a snapshot.
  const occ = (await sql`
    SELECT cart_snapshot
    FROM recurring_order_occurrences
    WHERE recurring_order_id = ${id} AND cart_snapshot IS NOT NULL
    ORDER BY scheduled_date ASC
    LIMIT 1
  `) as { cart_snapshot: CartItem[] | null }[]
  const cart = occ[0]?.cart_snapshot ?? []

  let result
  try {
    result = await checkMenuAvailability(order.restaurant_reference, cart)
  } catch {
    // Couldn't read the menu — don't pause on uncertainty.
    return NextResponse.json({ error: 'Could not check menu availability' }, { status: 502 })
  }

  if (!result.available) {
    await sql`UPDATE recurring_orders SET status = 'PAUSED', updated_at = NOW() WHERE id = ${id}`
    return NextResponse.json({ paused: true, unavailableItems: result.unavailableItems })
  }

  return NextResponse.json({ paused: false })
}
