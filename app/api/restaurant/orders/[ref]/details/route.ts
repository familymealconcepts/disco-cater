import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { loadFmOrderDetails, isoToFmDate, isUuid } from '../../../../../../lib/order-edit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Loads the full order details that pre-populate the edit page.
// Neon-first: Neon (disco_orders + disco_order_items) is the source of truth for
// the order's CURRENT state (items, date/time, totals — which reflect any native
// edits). FM /details (service auth) supplies the rich fields Neon doesn't store
// (tax breakdown, tips, restaurant/customer meta). When the order isn't mirrored
// in Neon yet, the FM payload is returned unchanged. The response keeps FM's
// nested { data: { order } } shape the edit client already parses.
interface DiscoFull {
  id: number
  reference: string
  fm_order_reference: string | null
  order_number: string
  order_status: string
  order_type: string
  restaurant_reference: string
  restaurant_name: string | null
  customer_email: string | null
  customer_first_name: string | null
  customer_last_name: string | null
  order_date: string
  order_time: string
  subtotal: string | null
  total: string | null
  fee: string | null
}
interface DiscoItem { meal_package_reference: string | null; name: string; quantity: number; price_per_unit: string; serves: number | null }

function num(v: unknown): number { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0 }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  // Admin portal (fm_admin_token) can load order details for the full edit page.
  const ctx = await getRestaurantAuthContext()
  if (!ctx) {
    try { await getAdminAuthHeader() }
    catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  }
  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  // FM details (best-effort) — the rich base the edit client already understands.
  const fmDetails = await loadFmOrderDetails(ref)
  const fmOrder = (((fmDetails?.data as Record<string, unknown>)?.order as Record<string, unknown>)
    ?? (fmDetails?.order as Record<string, unknown>)
    ?? fmDetails
    ?? null) as Record<string, unknown> | null

  // Neon order + items.
  let disco: DiscoFull | null = null
  let items: DiscoItem[] = []
  if (isUuid(ref)) {
    const rows = (await sql`
      SELECT id, reference, fm_order_reference, order_number, order_status, order_type,
             restaurant_reference, restaurant_name, customer_email, customer_first_name, customer_last_name,
             to_char(order_date,'YYYY-MM-DD') AS order_date, order_time::text AS order_time,
             subtotal, total, fee
      FROM disco_orders
      WHERE fm_order_reference = ${ref}::uuid OR reference = ${ref}::uuid
      LIMIT 1
    `.catch(() => [])) as DiscoFull[]
    disco = rows[0] ?? null
    if (disco) {
      items = (await sql`
        SELECT meal_package_reference, name, quantity, price_per_unit, serves
        FROM disco_order_items WHERE order_id = ${disco.id} ORDER BY id
      `.catch(() => [])) as DiscoItem[]
    }
  }

  if (!disco && !fmOrder) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  // FM-only (not in Neon yet) → return the FM payload as-is.
  if (!disco) {
    return NextResponse.json(fmDetails ?? { data: { order: fmOrder } })
  }

  // Neon-first merge onto the FM order node (or a fresh node when FM is absent).
  const d = disco as DiscoFull
  const order: Record<string, unknown> = fmOrder ? { ...fmOrder } : {}

  order.orderNumber = Number(d.order_number)
  order.orderStatus = d.order_status
  order.orderType = d.order_type
  // Match FM's native DD.MM.YYYY so the edit client's date normalizer is happy.
  order.orderDate = isoToFmDate(String(d.order_date).slice(0, 10))
  order.orderTime = d.order_time
  order.restaurantReference = d.restaurant_reference || order.restaurantReference
  order.restaurantName = d.restaurant_name || order.restaurantName
  order.userEmail = d.customer_email || order.userEmail
  order.email = d.customer_email || order.email
  order.firstName = d.customer_first_name || order.firstName
  order.lastName = d.customer_last_name || order.lastName
  if (d.subtotal != null) order.subtotal = num(d.subtotal)
  if (d.total != null) { order.total = num(d.total); order.transactionsTotal = num(d.total) }
  if (d.fee != null) order.fee = num(d.fee)

  // Items: Neon is the source of truth when present; else keep FM's.
  if (items.length) {
    order.orderMealPackages = items.map(it => ({
      reference: it.meal_package_reference || undefined,
      mealPackageReference: it.meal_package_reference || undefined,
      name: it.name,
      price: num(it.price_per_unit),
      count: it.quantity,
      serves: it.serves ?? null,
    }))
    order.orderClassics = []
  }

  return NextResponse.json({ data: { order } })
}
