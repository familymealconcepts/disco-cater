import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantRole, getRestaurantRef, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { getLocationAccessRefs } from '../../../../lib/disco-restaurant-auth'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'
import { syncRestaurantOrders } from '../../../../lib/fm-orders-sync'
import { cookies } from 'next/headers'
import { displayEmail } from '../../../../lib/customer-email-guard'

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
  // A refunded order stays in Active until the restaurant manually completes it;
  // Complete is the only allowed transition.
  REFUNDED: ['COMPLETED'],
  REFUND: ['COMPLETED'],
  PARTIAL_REFUND: ['COMPLETED'],
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
  bucket_date: string
  order_time: string
  subtotal: string | null
  total: string | null
  fee: string | null
  tips: string | null
  refund: string | null
  note: string | null
  seen_by_admin: boolean
  edit_count: number
  edit_status: string | null
  created_at: string | null
  placed_at: string | null
  persons: number | null
  company_name: string | null
  tax_exempt_id: string | null
  tax_exempt_state: string | null
  timezone: string | null
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
    email: displayEmail(r.customer_email),
    restaurantName: r.restaurant_name || undefined,
    orderDate: String(r.order_date).slice(0, 10), // YYYY-MM-DD
    // Which day this order counts toward for trend-chart bucketing — order_date
    // (default) or the restaurant-local created_at date, matching whichever the
    // ?dateType= request selected. Distinct from orderDate, which always shows
    // the customer's actual catering date regardless of dateType.
    bucketDate: String(r.bucket_date || r.order_date).slice(0, 10),
    orderTime: r.order_time,
    // Restaurant IANA tz — anchors the client's past-date / pickup gates so they
    // agree with the server regardless of the viewer's location.
    restaurantTimezone: r.timezone || 'America/New_York',
    orderType: r.order_type,
    deliveryType: r.delivery_type || '',
    transactionsTotal: total,
    total,
    subtotal: r.subtotal != null ? num(r.subtotal) : undefined,
    fee: r.fee != null ? num(r.fee) : undefined,
    refund: r.refund != null ? num(r.refund) : undefined,
    orderStatus: status,
    orderSeenByAdmin: r.seen_by_admin === true,
    orderStatusesToChange: STATUS_TRANSITIONS[status] || [],
    sourceoforder: r.source_of_order,
    note: r.note || undefined,
    maxAllowedRefundAmount: REFUNDABLE.has(status) ? total : 0,
    // Disco edit state (used by the edit-history icon rule / edit gate).
    editCount: r.edit_count,
    editStatus: r.edit_status,
    // When the order was placed (Created column) + headcount. placed_at is FM's
    // real order-creation timestamp when known (or native-checkout's real insert
    // time); created_at is Neon SYNC time for FM-mirrored orders, which can trail
    // real placement by hours to years — never the right thing to show as "Created."
    orderCreatedDate: r.placed_at || r.created_at || undefined,
    persons: r.persons ?? undefined,
    // Disco-only: company name + tax-exempt id/state for the details panel + PDF.
    companyName: r.company_name || undefined,
    taxExemptId: r.tax_exempt_id || undefined,
    taxExemptState: r.tax_exempt_state || undefined,
    taxExempt: !!r.tax_exempt_id,
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
  // Order Date (default) vs Created Date — mirrors app/api/restaurant/dashboard/
  // sale-stats/route.ts's discoSaleStats() so the graph and the cards agree on
  // which orders are in range. Previously this route ignored dateType entirely
  // (always filtered on order_date), silently overriding the toggle.
  const byCreated = sp.get('dateType') === 'createdDate'

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

  // SYSTEM_ADMIN aggregate (no specific location picked): include every location
  // the account has EXPLICIT access to (disco_restaurant_location_access for their
  // email — written by the promote-to-SYSTEM_ADMIN action). If there are no access
  // rows (e.g. an FM-native SYSTEM_ADMIN whose email isn't in our table), fall
  // back to their own FM-JWT / account restaurant_reference so they still see
  // their location instead of an empty list.
  //
  // READ-PATH GAP (deliberately deferred, not fixed): a disco-native
  // SUPER_ADMIN's aggregate here is still their own access rows / home ref,
  // not literally every restaurant's orders — a true platform-wide view would
  // need a real list-all query, not built. With neither, this returns an
  // empty order list below (never an error, never another owner's orders).
  let groupRefs: string[] | null = null
  if (!scopeRef && isSA) {
    let accessRefs: string[] = []
    try {
      accessRefs = (await getLocationAccessRefs(ctx.email)).filter(r => UUID_RE.test(r))
    } catch (e) {
      console.error('[restaurant/orders] location-access lookup failed:', e instanceof Error ? e.message : e)
    }
    if (accessRefs.length) {
      groupRefs = accessRefs
    } else if (ownRef && UUID_RE.test(ownRef)) {
      // 0 access rows → single-location fallback (FM-native SYSTEM_ADMIN).
      scopeRef = ownRef
    }
  }

  // Hard guard against an unscoped query. An FM-native SYSTEM_ADMIN
  // (ctx.authType !== 'disco') with no selected location has no scopeRef and no
  // groupRefs — without this it would return EVERY restaurant's orders in
  // disco_orders (cross-tenant exposure). Never query without a restaurant filter.
  const hasScope = !!(scopeRef && UUID_RE.test(scopeRef))
  if (!hasScope && (!groupRefs || groupRefs.length === 0)) {
    return NextResponse.json({ content: [], totalElements: 0, totalPages: 0, number: page, size, restaurantExists: false })
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

  // NOTE: qualify restaurant_reference with the table name. The list query below
  // joins disco_restaurant_cache (which also has a restaurant_reference column), so
  // an unqualified reference here is ambiguous and makes the whole list query throw.
  if (scopeRef && UUID_RE.test(scopeRef)) {
    add('disco_orders.restaurant_reference = ?::uuid', scopeRef)
  } else if (groupRefs) {
    // Disco SA aggregate — limit to the group's locations. An empty group still
    // adds an impossible-match clause so the SA never sees unrelated orders.
    const placeholders = groupRefs.map(r => { params.push(r); return `$${params.length}::uuid` })
    where.push(placeholders.length ? `disco_orders.restaurant_reference IN (${placeholders.join(',')})` : 'false')
  }
  if (statuses.length) {
    const placeholders = statuses.map(s => { params.push(s); return `$${params.length}` })
    where.push(`order_status IN (${placeholders.join(',')})`)
  }
  // Created Date mode compares the restaurant's LOCAL day, not created_at's UTC
  // day — a correlated subquery (rather than a JOIN) so this slots into both
  // the COUNT query and the list query, which don't otherwise share a FROM
  // clause with disco_restaurant_cache. COALESCE(placed_at, created_at): placed_at
  // is FM's real order-creation timestamp (backfilled for pre-freeze orders,
  // populated going forward by the fixed sync); created_at is Neon sync time,
  // which for FM-mirrored orders can trail real placement by hours to years —
  // "Created Date" mode means "when was this actually placed," not "when did
  // the mirror job run."
  const bucketDateExpr = byCreated
    ? `(COALESCE(placed_at, created_at) AT TIME ZONE COALESCE((SELECT timezone FROM disco_restaurant_cache WHERE restaurant_reference = disco_orders.restaurant_reference::text LIMIT 1), 'America/New_York'))::date`
    : 'order_date'
  if (fromDate) add(`${bucketDateExpr} >= ?::date`, fromDate)
  if (toDate) add(`${bucketDateExpr} <= ?::date`, toDate)
  if (search) {
    // Strip a leading '#' so "#87803110" matches the same as "87803110". Search
    // across full name, order number, and email — case-insensitive, at the SQL
    // level (not client-side).
    const cleaned = search.replace(/^#+/, '').trim()
    if (cleaned) {
      params.push(cleaned)
      const p = `$${params.length}`
      where.push(`(
        LOWER(COALESCE(customer_first_name,'') || ' ' || COALESCE(customer_last_name,'')) LIKE LOWER('%' || ${p} || '%')
        OR CAST(order_number AS TEXT) LIKE '%' || ${p} || '%'
        OR LOWER(COALESCE(customer_email,'')) LIKE LOWER('%' || ${p} || '%')
      )`)
    }
  }
  const whereSql = where.join(' AND ')

  try {
    const countRows = (await sql.query(`SELECT COUNT(*)::int AS c FROM disco_orders WHERE ${whereSql}`, params)) as { c: number }[]
    const totalElements = countRows[0]?.c ?? 0

    // For a single-location view, confirm the restaurant exists in the cache so
    // the client can show "No orders yet" (a real, new restaurant) rather than the
    // generic "No orders found". Only meaningful when scoped to one restaurant.
    let restaurantExists = false
    if (scopeRef && UUID_RE.test(scopeRef)) {
      try {
        const ex = (await sql.query(
          'SELECT 1 FROM disco_restaurant_cache WHERE restaurant_reference = $1 LIMIT 1',
          [scopeRef],
        )) as unknown[]
        restaurantExists = ex.length > 0
      } catch { /* best-effort */ }
    }

    const listParams = [...params, size, page * size]
    // Some 3P/Disco-native orders mirrored a null/0 total (the place mirror read
    // FM's pre-payment total). Fall back to the Stripe payment total for the order
    // (NULLIF so a stored 0 also falls through, not just NULL).
    const rows = (await sql.query(
      `SELECT disco_orders.reference, fm_order_reference, order_number, order_status, order_type, delivery_type,
              source_of_order, restaurant_name, customer_email, customer_first_name, customer_last_name,
              to_char(order_date,'YYYY-MM-DD') AS order_date, order_time::text AS order_time,
              to_char(${byCreated ? "(COALESCE(placed_at, created_at) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))" : 'order_date'}, 'YYYY-MM-DD') AS bucket_date,
              subtotal, COALESCE(NULLIF(disco_orders.total, 0), sp.sp_total) AS total, fee, tips, refund, note, seen_by_admin,
              COALESCE(edit_count,0) AS edit_count, edit_status, created_at, placed_at, persons,
              company_name, tax_exempt_id, tax_exempt_state, rc.timezone AS timezone
       FROM disco_orders
       LEFT JOIN (
         SELECT order_reference, MAX(total) AS sp_total
         FROM disco_stripe_payments
         WHERE total IS NOT NULL AND total > 0
         GROUP BY order_reference
       ) sp ON sp.order_reference = disco_orders.reference
       LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = disco_orders.restaurant_reference::text
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
      restaurantExists,
    })
  } catch (err) {
    console.error('restaurant/orders GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
