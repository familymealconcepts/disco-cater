import { NextRequest, NextResponse } from 'next/server'
import { getFmCustomerJwt, getCustomerSession } from '../../../../lib/customer-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { getCallerScopeRefs } from '../../../../lib/order/order-scope'
import { sql } from '../../../../lib/db'
import { loadOrderItemsWithAddOns } from '../../../../lib/order-items'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

interface ConfirmationItem {
  name: string; quantity: number; price: number; lineTotal: number
  addOns?: { name: string; price: number; quantity: number }[]
}

// Normalize the order's line items into a single { name, quantity, price,
// lineTotal } shape the confirmation page can render directly. FM nests them
// under orderMealPackages (count/price/name); also tolerate mealPackages/items.
function itemsFromFm(data: Record<string, unknown>): ConfirmationItem[] {
  const raw = (Array.isArray(data.orderMealPackages) ? data.orderMealPackages
    : Array.isArray(data.mealPackages) ? data.mealPackages
    : Array.isArray(data.items) ? data.items
    : []) as Record<string, unknown>[]
  return raw.map((it) => {
    const nested = (it.mealPackage as Record<string, unknown> | undefined) ?? undefined
    const name = String(it.name ?? it.mealPackageName ?? nested?.name ?? 'Item')
    const quantity = Math.max(1, Math.trunc(num(it.count) || num(it.quantity) || 1))
    const price = num(it.price) || num(it.pricePerUnit) || num(nested?.price)
    return { name, quantity, price, lineTotal: Math.round(price * quantity * 100) / 100 }
  })
}

// Authorize the viewer of a Neon-backed order: EITHER the order's own customer (a
// diner viewing their confirmation) OR the restaurant that owns the order (Direct
// Entry — the admin placed it on a walk-in's behalf and views the confirmation with
// a restaurant session, not a customer session).
async function authorizeStatusViewer(req: NextRequest, nr: Record<string, unknown>): Promise<boolean> {
  const session = await getCustomerSession(req)
  if (session && (session.email || '').toLowerCase() === String(nr.customer_email || '').toLowerCase()) return true
  const ctx = await getRestaurantAuthContext()
  if (ctx) {
    const scope = await getCallerScopeRefs(ctx)
    if (scope.has(String(nr.restaurant_reference || '').toLowerCase())) return true
  }
  return false
}

// Build the confirmation payload entirely from the Neon mirror (items, totals,
// dates, snapshot restaurant name). Used for native orders and as the permanent
// fallback for FM-backed orders whose restaurant no longer resolves in FM — a paid
// order is a receipt and must stay viewable independent of the restaurant's state.
// native:true so the confirmation page uses the Neon PDF route (/api/order/[ref]/pdf).
async function buildNeonStatus(nr: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stRows = (await sql`
    SELECT state_tax, local_tax, other_tax, own_delivery_fee, third_party_delivery_fee, discount
    FROM disco_sale_transactions WHERE order_id = ${nr.id as number} ORDER BY id LIMIT 1
  `) as Array<Record<string, unknown>>
  const st = stRows[0] || {}
  const orderItems = await loadOrderItemsWithAddOns(nr.id as number)
  const items: ConfirmationItem[] = orderItems.map((it) => ({
    name: it.name, quantity: it.quantity, price: it.pricePerUnit,
    lineTotal: Math.round(it.pricePerUnit * it.quantity * 100) / 100,
    addOns: it.addOns.length ? it.addOns.map((a) => ({ name: a.name, price: a.price, quantity: a.quantity })) : undefined,
  }))
  // Restaurant name: prefer the frozen snapshot on the order, fall back to the live
  // cache (empty for a deleted restaurant → the page just omits the name).
  let restaurantName = String(nr.restaurant_name || '')
  if (!restaurantName) {
    const rc = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${nr.restaurant_reference as string} LIMIT 1`.catch(() => [])) as Array<{ name: string | null }>
    restaurantName = rc[0]?.name || ''
  }
  const line1 = nr.delivery_address_line1 as string | null
  return {
    native: true,
    orderNumber: nr.order_number,
    orderStatus: nr.order_status,
    orderType: nr.order_type,
    orderDate: nr.order_date,
    orderTime: nr.order_time,
    firstName: nr.customer_first_name,
    lastName: nr.customer_last_name,
    restaurantName,
    companyName: nr.company_name || '',
    persons: nr.persons != null ? Number(nr.persons) : undefined,
    note: nr.note || '',
    deliveryTimeWindow: nr.delivery_time_window || '',
    subtotal: num(nr.subtotal),
    total: num(nr.total),
    fee: num(nr.fee),
    tips: num(nr.tips),
    deliveryFee: num(st.own_delivery_fee) + num(st.third_party_delivery_fee),
    stateSalesTaxInPrice: num(st.state_tax),
    localSalesTaxInPrice: num(st.local_tax),
    otherSalesTaxInPrice: num(st.other_tax),
    discount: num(st.discount),
    refund: num(nr.refund),
    taxExemptId: nr.tax_exempt_id || '',
    taxExempt: !!nr.tax_exempt_id,
    taxExemptState: nr.tax_exempt_state || '',
    deliveryAddress: line1 ? {
      addressLine1: line1,
      addressLine2: nr.delivery_address_line2 || '',
      city: nr.delivery_city || '', state: nr.delivery_state || '', zipcode: nr.delivery_zip || '',
    } : undefined,
    items,
  }
}

export async function GET(req: NextRequest) {
  try {
    const orderRef = req.nextUrl.searchParams.get('orderRef')
    if (!orderRef) return NextResponse.json({ error: 'orderRef required' }, { status: 400 })

    // Load the Neon mirror row (native OR FM-backed) — used to serve native orders
    // directly and as the FM fallback below.
    let nr: Record<string, unknown> | null = null
    if (UUID_RE.test(orderRef)) {
      const rows = (await sql`
        SELECT o.id, o.fm_order_reference, o.order_number, o.order_status, o.order_type,
               o.customer_email, o.customer_first_name, o.customer_last_name,
               to_char(o.order_date,'YYYY-MM-DD') AS order_date, o.order_time::text AS order_time,
               o.subtotal, o.total, o.fee, o.tips, o.refund, o.note, o.company_name, o.persons,
               o.delivery_time_window, o.tax_exempt_id, o.tax_exempt_state,
               o.delivery_address_line1, o.delivery_address_line2, o.delivery_city, o.delivery_state, o.delivery_zip,
               o.restaurant_reference, o.restaurant_name
        FROM disco_orders o
        WHERE o.reference = ${orderRef}::uuid OR o.fm_order_reference = ${orderRef}::uuid
        LIMIT 1
      `) as Array<Record<string, unknown>>
      nr = rows[0] ?? null
    }

    // Native order → serve entirely from Neon.
    if (nr && !nr.fm_order_reference) {
      if (!(await authorizeStatusViewer(req, nr))) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
      return NextResponse.json(await buildNeonStatus(nr), { status: 200 })
    }

    // ── FM-backed path ──────────────────────────────────────────────────────
    // Resolve the FM JWT from the Disco customer session, refreshing it if expired.
    const token = await getFmCustomerJwt(req)
    if (!token) {
      // No FM session — fall back to the permanent Neon receipt if authorized.
      if (nr && await authorizeStatusViewer(req, nr)) return NextResponse.json(await buildNeonStatus(nr), { status: 200 })
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    let res: Response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = null
    try {
      res = await fetch(`${FM}/api/userOrder/${orderRef}`, {
        headers: { Accept: 'application/json', Authorization: token },
      })
      data = await res.json().catch(() => null)
    } catch (e) {
      // FM unreachable → the order is still a permanent receipt in Neon.
      console.warn('[order/status] FM fetch threw, falling back to Neon:', e instanceof Error ? e.message : e, orderRef)
      if (nr && await authorizeStatusViewer(req, nr)) return NextResponse.json(await buildNeonStatus(nr), { status: 200 })
      return NextResponse.json({ error: 'Failed to fetch order status' }, { status: 502 })
    }

    // Ensure the tax-exempt id reaches the confirmation page. FM usually returns
    // taxExempt/taxExemptId, but fall back to Neon (persisted at placement) so the
    // confirmation can always show the exemption.
    if (res.ok && data && typeof data === 'object' && !data.taxExemptId && UUID_RE.test(orderRef)) {
      try {
        const rows = (await sql`
          SELECT tax_exempt_id FROM disco_orders
          WHERE fm_order_reference = ${orderRef}::uuid OR reference = ${orderRef}::uuid
          LIMIT 1
        `) as { tax_exempt_id: string | null }[]
        const tid = rows[0]?.tax_exempt_id
        if (tid) { data.taxExemptId = tid; data.taxExempt = true }
      } catch { /* best-effort enrichment */ }
    }

    // Company name, headcount, tax-exempt state + refund are Disco-only (in the
    // Neon mirror, not the FM order) — enrich so the confirmation page can show
    // them and the net total.
    if (res.ok && data && typeof data === 'object' && UUID_RE.test(orderRef)) {
      try {
        const rows = (await sql`
          SELECT o.total AS o_total, o.company_name, o.persons, o.tax_exempt_state, o.refund,
                 o.order_type, o.delivery_time_window, o.note,
                 (SELECT MAX(sp.total) FROM disco_stripe_payments sp
                  WHERE sp.order_reference = o.reference AND sp.total IS NOT NULL AND sp.total > 0) AS sp_total
          FROM disco_orders o
          WHERE o.fm_order_reference = ${orderRef}::uuid OR o.reference = ${orderRef}::uuid
          LIMIT 1
        `) as { o_total: string | null; company_name: string | null; persons: number | null; tax_exempt_state: string | null; refund: string | null; order_type: string | null; delivery_time_window: string | null; note: string | null; sp_total: string | null }[]
        const d = data as Record<string, unknown>
        const cn = rows[0]?.company_name
        if (cn) d.companyName = cn
        // Order note (utensils etc.) — surfaced on the confirmation page.
        const onote = rows[0]?.note
        if (onote && !d.note) d.note = onote
        // Delivery time-window snapshot → the confirmation page renders the
        // delivery time as a range. Fall back to Neon's order_type if FM omits it.
        const dtw = rows[0]?.delivery_time_window
        if (dtw) d.deliveryTimeWindow = dtw
        if (!d.orderType && rows[0]?.order_type) d.orderType = rows[0].order_type
        const persons = rows[0]?.persons
        if (persons != null && Number(persons) > 0 && d.persons == null) d.persons = Number(persons)
        const tes = rows[0]?.tax_exempt_state
        if (tes && !d.taxExemptState) d.taxExemptState = tes
        if (!Number(d.refund)) {
          const r = Number(rows[0]?.refund)
          if (Number.isFinite(r) && r > 0) d.refund = r
        }
        // Authoritative total: disco_orders.total (the actual charge — already the
        // tax-exempt-reduced amount) falling back to the Stripe payment total. This
        // overrides FM's tax-inclusive total so the confirmation page matches the
        // restaurant portal / PDF / email / Slack (which all use this same source),
        // fixing the same-order-different-amount discrepancy.
        const authTotal = Number(rows[0]?.o_total) > 0 ? Number(rows[0]?.o_total) : Number(rows[0]?.sp_total)
        if (Number.isFinite(authTotal) && authTotal > 0) d.total = authTotal
      } catch { /* best-effort enrichment */ }
    }

    // Attach a normalized `items` array for the itemized list on the confirmation
    // page. Prefer FM's orderMealPackages; fall back to the Neon mirror
    // (disco_order_items) so the list shows even when FM omits the line items.
    if (res.ok && data && typeof data === 'object') {
      let items = itemsFromFm(data as Record<string, unknown>)
      if (items.length === 0 && UUID_RE.test(orderRef)) {
        try {
          const idRows = (await sql`
            SELECT id FROM disco_orders WHERE fm_order_reference = ${orderRef}::uuid OR reference = ${orderRef}::uuid LIMIT 1
          `) as { id: number }[]
          if (idRows[0]) {
            const orderItems = await loadOrderItemsWithAddOns(idRows[0].id)
            items = orderItems.map((it) => ({
              name: it.name, quantity: it.quantity, price: it.pricePerUnit,
              lineTotal: Math.round(it.pricePerUnit * it.quantity * 100) / 100,
              addOns: it.addOns.length ? it.addOns.map((a) => ({ name: a.name, price: a.price, quantity: a.quantity })) : undefined,
            }))
          }
        } catch { /* best-effort — confirmation still renders without items */ }
      }
      ;(data as Record<string, unknown>).items = items
    }

    // FM couldn't resolve the order (e.g. its restaurant was deleted) → serve the
    // permanent Neon receipt instead of surfacing FM's error.
    if (!res.ok && nr && await authorizeStatusViewer(req, nr)) {
      return NextResponse.json(await buildNeonStatus(nr), { status: 200 })
    }

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch order status' }, { status: 500 })
  }
}
