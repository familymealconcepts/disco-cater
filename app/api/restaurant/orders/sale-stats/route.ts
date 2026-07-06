import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM's saleStats endpoint parses dates in DD.MM.YYYY (DateFormatService.formatDate
// in the Angular client). The Order Counts tab sends YYYY-MM-DD (from <input
// type="date">), which FM can't parse → 400 → "Failed". Convert here.
function toFmDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d
}

// Order Counts for a disco-native restaurant — how many of each item were ordered
// in the date range, from disco_order_items. { mealPackages, addOns } matches the
// tab + CSV/PDF export. (Native line items carry no separate modifier rows, so
// addOns is empty.)
async function discoOrderCounts(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ mealPackages: [], addOns: [] })
  const sp = req.nextUrl.searchParams
  const iso = (d: string | null) => (d && /^\d{2}\.\d{2}\.\d{4}$/.test(d) ? d.split('.').reverse().join('-') : d)
  const from = iso(sp.get('fromDate'))
  const to = iso(sp.get('toDate'))
  const statuses = sp.getAll('orderStatuses')
  const statusFilter = statuses.length ? statuses : ['COMPLETED', 'DUE']
  await runDiscoOrderMigrations()
  const mealPackages = (await sql`
    SELECT oi.name AS "mealPackageName",
           SUM(oi.quantity)::int AS count,
           MAX(oi.price_per_unit)::float8 AS price,
           SUM(oi.total_price)::float8 AS total
    FROM disco_order_items oi
    JOIN disco_orders o ON o.id = oi.order_id
    WHERE o.restaurant_reference = ${ref}::uuid
      AND o.order_status = ANY(${statusFilter})
      AND (${from}::date IS NULL OR o.order_date >= ${from}::date)
      AND (${to}::date IS NULL OR o.order_date <= ${to}::date)
    GROUP BY oi.name
    ORDER BY count DESC, "mealPackageName" ASC
  `) as Record<string, unknown>[]
  return NextResponse.json({ mealPackages, addOns: [] })
}

export async function GET(req: NextRequest) {
  // Disco-native: item counts from Neon (was FM-only → 401 / "Failed").
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return discoOrderCounts(ctx, req)

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { searchParams } = req.nextUrl
  const params = new URLSearchParams()
  searchParams.getAll('orderStatuses').forEach(s => params.append('orderStatuses', s))
  const fromDate = searchParams.get('fromDate')
  const toDate = searchParams.get('toDate')
  if (fromDate) params.set('fromDate', toFmDate(fromDate))
  if (toDate) params.set('toDate', toFmDate(toDate))

  const fmUrl = `${FM}/api/orders/saleStats?${params}`
  // DIAGNOSTIC (Vercel logs): exact URL + params sent to FM for Order Counts.
  console.log('[orders/sale-stats] → FM', JSON.stringify({ url: fmUrl, fromDate, toDate, params: params.toString() }))

  try {
    const res = await fetch(fmUrl, { headers: authHeaders })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.log('[orders/sale-stats] ← FM error', JSON.stringify({ status: res.status, body: body.slice(0, 500) }))
      return NextResponse.json({ error: 'Failed' }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('[orders/sale-stats] fetch threw', err)
    return NextResponse.json({ error: 'Unable to fetch' }, { status: 500 })
  }
}
