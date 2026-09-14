import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'
import { cartLineTotal, lineUnitPrice } from '../../../../../lib/pricing/cart'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM's saleStats endpoint parses dates in DD.MM.YYYY (DateFormatService.formatDate
// in the Angular client). The Order Counts tab sends YYYY-MM-DD (from <input
// type="date">), which FM can't parse → 400 → "Failed". Convert here.
function toFmDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d
}

// Order Counts for a disco-native restaurant — how many of each item (and each
// add-on) were ordered in the date range. { mealPackages, addOns } matches the
// tab + CSV/PDF export. This is a date-range AGGREGATE across many orders, not
// a single order's line items, so it doesn't go through
// lib/order-items.ts's loadOrderItemsWithAddOns (that's per-order) — it needs
// its own grouped query, joined the same way. Previously hardcoded
// `addOns: []` with a comment claiming "native line items carry no separate
// modifier rows" — stale the moment native-checkout.ts started writing
// disco_order_item_addons; this undercounted every native restaurant's
// modifier sales in the export.
async function discoOrderCounts(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ mealPackages: [], addOns: [], itemsTotal: 0, modifiersIncluded: 0 })
  const sp = req.nextUrl.searchParams
  const iso = (d: string | null) => (d && /^\d{2}\.\d{2}\.\d{4}$/.test(d) ? d.split('.').reverse().join('-') : d)
  const from = iso(sp.get('fromDate'))
  const to = iso(sp.get('toDate'))
  const statuses = sp.getAll('orderStatuses')
  const statusFilter = statuses.length ? statuses : ['COMPLETED', 'DUE']
  await runDiscoOrderMigrations()

  // One row per order line, with its modifiers attached, so the line total can be
  // computed with the SHARED rule rather than a second copy of it in SQL. Volume
  // is a single restaurant over a date range (the busiest restaurant in the fleet
  // has ~11k lines all-time), so aggregating in JS is cheap and keeps
  // lib/pricing/cart.ts as the only implementation of the formula.
  type LineRow = {
    name: string
    quantity: number
    price: number
    addons: Array<{ name: string | null; price: number; count: number }> | null
  }
  const linesSql = (withAddOns: boolean) => (withAddOns ? sql`
    SELECT oi.name AS name, oi.quantity::int AS quantity, oi.price_per_unit::float8 AS price,
           COALESCE(
             json_agg(json_build_object('name', a.name, 'price', a.price::float8, 'count', a.quantity::int))
               FILTER (WHERE a.id IS NOT NULL),
             '[]'::json
           ) AS addons
    FROM disco_order_items oi
    JOIN disco_orders o ON o.id = oi.order_id
    LEFT JOIN disco_order_item_addons a ON a.order_item_id = oi.id
    WHERE o.restaurant_reference = ${ref}::uuid
      AND o.order_status = ANY(${statusFilter})
      AND (${from}::date IS NULL OR o.order_date >= ${from}::date)
      AND (${to}::date IS NULL OR o.order_date <= ${to}::date)
    GROUP BY oi.id, oi.name, oi.quantity, oi.price_per_unit
  ` : sql`
    SELECT oi.name AS name, oi.quantity::int AS quantity, oi.price_per_unit::float8 AS price,
           '[]'::json AS addons
    FROM disco_order_items oi
    JOIN disco_orders o ON o.id = oi.order_id
    WHERE o.restaurant_reference = ${ref}::uuid
      AND o.order_status = ANY(${statusFilter})
      AND (${from}::date IS NULL OR o.order_date >= ${from}::date)
      AND (${to}::date IS NULL OR o.order_date <= ${to}::date)
  `)
  // Fall back to a modifier-free read if disco_order_item_addons is missing, so
  // the Items table still renders (matches the old query's defensive .catch).
  const rows = (await linesSql(true).catch(() => linesSql(false))) as LineRow[]

  const round2 = (n: number) => Math.round(n * 100) / 100
  type Agg = { count: number; price: number; total: number }
  const itemMap = new Map<string, Agg>()
  const addOnMap = new Map<string, Agg & { addOnName: string; mealPackageName: string }>()

  for (const r of rows) {
    const qty = Number(r.quantity) || 0
    const base = Number(r.price) || 0
    const addOns = (r.addons ?? []).map(a => ({
      name: a.name || '',
      price: Number(a.price) || 0,
      count: Number(a.count) || 0,
    }))

    // THE rule — (base + Σ(modifier.price × modifier.count)) × quantity — taken
    // from lib/pricing/cart.ts, the same helper the cart, checkout and the order
    // edit route use. Not reimplemented here.
    const it = itemMap.get(r.name) ?? { count: 0, price: 0, total: 0 }
    it.count += qty
    // Price is the EFFECTIVE unit price (base + this line's per-unit modifiers),
    // not the bare base. Otherwise the 16,150 lines whose whole value sits on
    // modifiers show "Price $0.00" next to a non-zero Total. Still a MAX across
    // lines of the same item, as before, since different lines carry different
    // modifiers — Total is the authoritative figure, Price is indicative.
    it.price = Math.max(it.price, lineUnitPrice({ price: base, count: qty, addOns }))
    it.total += cartLineTotal({ price: base, count: qty, addOns })
    itemMap.set(r.name, it)

    for (const a of addOns) {
      const key = `${a.name}\u0000${r.name}`
      const ao = addOnMap.get(key) ?? { addOnName: a.name, mealPackageName: r.name, count: 0, price: 0, total: 0 }
      // A modifier is chosen per UNIT, so a line of `qty` sells it `qty` times.
      // cart.ts's header documents the same scaling: Σ(addon.price × addon.count
      // × meal.count). The old query omitted × oi.quantity from BOTH the count
      // and the total, undercounting every multi-unit line.
      ao.count += a.count * qty
      ao.price = Math.max(ao.price, a.price)
      ao.total += a.price * a.count * qty
      addOnMap.set(key, ao)
    }
  }

  const byCountThenName = (aName: string, bName: string, aCount: number, bCount: number) =>
    bCount - aCount || aName.localeCompare(bName)
  const mealPackages = [...itemMap.entries()]
    .map(([name, v]) => ({ mealPackageName: name, count: v.count, price: v.price, total: round2(v.total) }))
    .sort((x, y) => byCountThenName(x.mealPackageName, y.mealPackageName, x.count, y.count))
  const addOns = [...addOnMap.values()]
    .map(v => ({ addOnName: v.addOnName, mealPackageName: v.mealPackageName, count: v.count, price: v.price, total: round2(v.total) }))
    .sort((x, y) => byCountThenName(x.addOnName, y.addOnName, x.count, y.count))

  // `addOns` is a BREAKDOWN of revenue already inside `mealPackages` totals — not
  // a second, additive category. Consumers must not sum the two. itemsTotal is
  // the one true revenue figure for the range.
  const itemsTotal = round2(mealPackages.reduce((sum, m) => sum + m.total, 0))
  const modifiersIncluded = round2(addOns.reduce((sum, a) => sum + a.total, 0))
  return NextResponse.json({ mealPackages, addOns, itemsTotal, modifiersIncluded })

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
