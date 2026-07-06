import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Orders that count toward a customer's history (placed + paid; excludes carts /
// reservations that never paid).
const PAID = ['DUE', 'COMPLETED', 'PAID', 'PARTIAL_REFUND', 'REFUND']

// Disco-native customer CRM — derived from disco_orders (the data FM used to serve).
// One row per customer_email for the scoped restaurant: name, phone, order count,
// lifetime spend. Uses the email as the customer's reference (the detail page + the
// per-customer orders route look up by it). Returns FM's { content, totalElements }
// envelope + field names so the page needs no changes.
async function discoCustomers(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ content: [], totalElements: 0 })
  const search = (req.nextUrl.searchParams.get('search') || '').trim().toLowerCase()
  await runDiscoOrderMigrations()
  const rows = (await sql`
    SELECT
      customer_email AS "customerReference",
      customer_email AS email,
      (ARRAY_AGG(NULLIF(TRIM(COALESCE(customer_first_name, '') || ' ' || COALESCE(customer_last_name, '')), '') ORDER BY order_date DESC NULLS LAST))[1] AS username,
      (ARRAY_AGG(NULLIF(customer_phone, '') ORDER BY order_date DESC NULLS LAST))[1] AS "phoneNumber",
      COUNT(*)::int AS "numberOfOrders",
      COALESCE(SUM(total), 0)::float8 AS totalspend,
      to_char(MAX(order_date), 'YYYY-MM-DD') AS "lastOrderDate"
    FROM disco_orders
    WHERE restaurant_reference = ${ref}::uuid
      AND customer_email IS NOT NULL AND customer_email <> ''
      AND order_status = ANY(${PAID})
      AND (${search} = '' OR LOWER(customer_email) LIKE '%' || ${search} || '%'
           OR LOWER(COALESCE(customer_first_name, '') || ' ' || COALESCE(customer_last_name, '')) LIKE '%' || ${search} || '%')
    GROUP BY customer_email
    ORDER BY MAX(order_date) DESC NULLS LAST
  `) as Record<string, unknown>[]
  return NextResponse.json({ content: rows, totalElements: rows.length })
}

export async function GET(req: NextRequest) {
  // Disco-native restaurants: build the CRM from Neon (was FM-only → 401).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return discoCustomers(ctx, req)

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const params = new URLSearchParams()
    if (sp.get('page')) params.set('page', sp.get('page')!)
    if (sp.get('size')) params.set('size', sp.get('size')!)
    if (sp.get('sort')) params.set('sort', sp.get('sort')!)
    if (sp.get('search')) params.set('search', sp.get('search')!)
    params.set('restaurantReference', restaurantRef)

    const res = await fetch(`${FM}/api/customer/users?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch customers' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch customers' }, { status: 500 })
  }
}
