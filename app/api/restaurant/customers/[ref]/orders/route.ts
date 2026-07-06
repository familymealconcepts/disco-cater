import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const PAID = ['DUE', 'COMPLETED', 'PAID', 'PARTIAL_REFUND', 'REFUND']

// Disco-native per-customer order history from disco_orders. `ref` is the customer
// email (the CRM list uses it as customerReference). Scoped to this restaurant.
async function discoCustomerOrders(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, email: string) {
  const restaurantRef = await resolveDiscoScopeRef(ctx)
  if (!restaurantRef || !email) return NextResponse.json({ content: [] })
  await runDiscoOrderMigrations()
  const rows = (await sql`
    SELECT order_number AS "orderNumber",
           to_char(order_date, 'YYYY-MM-DD') AS "orderDate",
           COALESCE(total, 0)::float8 AS total,
           order_status AS status,
           order_type AS "orderType",
           reference
    FROM disco_orders
    WHERE restaurant_reference = ${restaurantRef}::uuid
      AND LOWER(customer_email) = ${email.toLowerCase()}
      AND order_status = ANY(${PAID})
    ORDER BY order_date DESC NULLS LAST, created_at DESC
  `) as Record<string, unknown>[]
  return NextResponse.json({ content: rows })
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ref: string }> }
) {
  const { ref } = await params

  // Disco-native: read the customer's orders from Neon (was FM-only → 401).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return discoCustomerOrders(ctx, decodeURIComponent(ref))

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const url = `${FM}/api/customer/users/${ref}/orders?from=RESTAURANT&restaurant_ref=${restaurantRef}`
    const res = await fetch(url, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch customer orders' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch customer orders' }, { status: 500 })
  }
}
