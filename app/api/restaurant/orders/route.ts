import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantRole, getRestaurantRef, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../lib/disco-restaurant-auth'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'
import { syncRestaurantOrders } from '../../../../lib/fm-orders-sync'
import { cookies } from 'next/headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Which statuses an order can transition to (drives the drawer's status select).
// Status changes still go to FM via the /status route; the sync pulls the result
// back into Neon on the next load.
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DUE: ['COMPLETED', 'CANCELED'],
  PAID: ['COMPLETED', 'CANCELED'],
  UNPAID: ['CANCELED'],
  RESERVED: ['DUE', 'CANCELED'],
  COMPLETED: ['REOPEN'],
}
const REFUNDABLE = new Set(['DUE', 'PAID', 'COMPLETED'])

interface OrderRow {
  reference: string
  fm_order_reference: string | null
  order_number: string
  order_status: string
  order_type: string
  delivery_type: string | null
  source_of_order: string
  restaurant_name: string | null
  customer_first_name: string | null
  customer_last_name: string | null
  customer_email: string | null
  order_date: string
  order_time: string
  subtotal: string | null
  total: string | null
  fee: string | null
  tips: string | null
  note: string | null
  seen_by_admin: boolean
  edit_count: number
  edit_status: string | null
  created_at: string | null
  persons: number | null
}

function num(v: unknown): number { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0 }

// Map a disco_orders row → the OrderInfoResponseDto shape the portal table/drawer
// expect (so no frontend change is needed beyond the data source).
function toUiOrder(r: OrderRow): Record<string, unknown> {
  const ref = r.fm_order_reference || r.reference
  const total = num(r.total)
  const status = r.order_status
  return {
    orderReference: ref,
    orderNumber: Number(r.order_number),
    firstName: r.customer_first_name || '',
    lastName: r.customer_last_name || '',
    email: r.customer_email || '',
    restaurantName: r.restaurant_name || undefined,
    orderDate: String(r.order_date).slice(0, 10), // YYYY-MM-DD
    orderTime: r.order_time,
    orderType: r.order_type,
    deliveryType: r.delivery_type || '',
    transactionsTotal: total,
    total,
    subtotal: r.subtotal != null ? num(r.subtotal) : undefined,
    fee: r.fee != null ? num(r.fee) : undefined,
    orderStatus: status,
    orderSeenByAdmin: r.seen_by_admin === true,
    orderStatusesToChange: STATUS_TRANSITIONS[status] || [],
    sourceoforder: r.source_of_order,
    note: r.note || undefined,
    maxAllowedRefundAmount: REFUNDABLE.has(status) ? total : 0,
    // Disco edit state (used by the edit-history icon rule / edit gate).
    editCount: r.edit_count,
    editStatus: r.edit_status,
    // When the order was placed (Created column) + headcount.
    orderCreatedDate: r.created_at || undefined,
    persons: r.persons ?? undefined,
  }
}

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  const sp = req.nextUrl.searchParams
  const page = Math.max(0, parseInt(sp.get('page') || '0', 10) || 0)
  const size = Math.min(200, Math.max(1, parseInt(sp.get('size') || '25', 10) || 25))
  const statuses = sp.getAll('orderStatuses').filter(Boolean)
  const search = (sp.get('search') || '').trim()
  const fromDate = (sp.get('fromDate') || '').trim()
  const toDate = (sp.get('toDate') || '').trim()

  // Scope to ONE restaurant (UUID). Explicit ?restaurantReference wins; else a
  // SA's selected location; else the ADMIN's own restaurant. A SA with no
  // selection → aggregate across all their locations.
  //
  // Role/own-reference come from the Disco account for Disco-native sessions
  // (driven by disco_restaurant_accounts.role), and from the FM JWT otherwise.
  const queryRef = sp.get('restaurantReference') || ''
  const store = await cookies()
  const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
  const role = ctx.authType === 'disco' ? (ctx.role || 'ADMIN') : await getRestaurantRole()
  const ownRef = ctx.authType === 'disco' ? (ctx.restaurantReference || '') : (await getRestaurantRef()) || ''
  const isSA = role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN'
  let scopeRef = queryRef
  if (!scopeRef && isSA && selected) scopeRef = selected
  if (!scopeRef && !isSA) scopeRef = ownRef

  // Disco SYSTEM_ADMIN aggregate (no specific location picked): restrict to the
  // group's locations rather than every restaurant in disco_orders. FM SAs are
  // still scoped server-side by FM, so this only applies to Disco sessions.
  let groupRefs: string[] | null = null
  if (!scopeRef && isSA && ctx.authType === 'disco') {
    try {
      const group = await getDiscoGroupAccounts(ctx.businessName, ctx.email)
      groupRefs = group.map(a => a.restaurant_reference).filter(r => UUID_RE.test(r))
    } catch (e) {
      console.error('[restaurant/orders] group scope lookup failed:', e instanceof Error ? e.message : e)
    }
  }

  // Lightweight FM→Neon sync for the scoped restaurant before reading, so the
  // list reflects the latest FM state. Bounded to the most recent page (order
  // level only, no per-order items) to keep page loads fast; never blocks the
  // read on failure. Skipped for the all-locations aggregate view (too heavy to
  // sync inline) — use POST /api/admin/sync/fm-orders for a full backfill.
  if (scopeRef && UUID_RE.test(scopeRef)) {
    try {
      await syncRestaurantOrders(scopeRef, { withItems: false, pageSize: 50, maxPages: 1 })
    } catch (e) {
      console.error('[restaurant/orders] inline sync failed (non-fatal):', e instanceof Error ? e.message : e)
    }
  }

  // Build the filtered query with positional params.
  const where: string[] = ['is_deleted = false']
  const params: unknown[] = []
  const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)) }

  if (scopeRef && UUID_RE.test(scopeRef)) {
    add('restaurant_reference = ?::uuid', scopeRef)
  } else if (groupRefs) {
    // Disco SA aggregate — limit to the group's locations. An empty group still
    // adds an impossible-match clause so the SA never sees unrelated orders.
    const placeholders = groupRefs.map(r => { params.push(r); return `$${params.length}::uuid` })
    where.push(placeholders.length ? `restaurant_reference IN (${placeholders.join(',')})` : 'false')
  }
  if (statuses.length) {
    const placeholders = statuses.map(s => { params.push(s); return `$${params.length}` })
    where.push(`order_status IN (${placeholders.join(',')})`)
  }
  if (fromDate) add('order_date >= ?::date', fromDate)
  if (toDate) add('order_date <= ?::date', toDate)
  if (search) {
    params.push(`%${search}%`)
    const p = `$${params.length}`
    where.push(`(customer_first_name ILIKE ${p} OR customer_last_name ILIKE ${p} OR (COALESCE(customer_first_name,'')||' '||COALESCE(customer_last_name,'')) ILIKE ${p} OR order_number::text ILIKE ${p})`)
  }
  const whereSql = where.join(' AND ')

  try {
    const countRows = (await sql.query(`SELECT COUNT(*)::int AS c FROM disco_orders WHERE ${whereSql}`, params)) as { c: number }[]
    const totalElements = countRows[0]?.c ?? 0

    const listParams = [...params, size, page * size]
    const rows = (await sql.query(
      `SELECT reference, fm_order_reference, order_number, order_status, order_type, delivery_type,
              source_of_order, restaurant_name, customer_email, customer_first_name, customer_last_name,
              to_char(order_date,'YYYY-MM-DD') AS order_date, order_time::text AS order_time,
              subtotal, total, fee, tips, note, seen_by_admin,
              COALESCE(edit_count,0) AS edit_count, edit_status, created_at, persons
       FROM disco_orders
       WHERE ${whereSql}
       ORDER BY order_date DESC, order_time DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams,
    )) as OrderRow[]

    return NextResponse.json({
      content: rows.map(toUiOrder),
      totalElements,
      totalPages: Math.ceil(totalElements / size),
      number: page,
      size,
    })
  } catch (err) {
    console.error('restaurant/orders GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
