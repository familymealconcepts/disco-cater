import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'
import { getCustomerSession } from '../../../../lib/customer-auth'
import { sql } from '../../../../lib/db'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const dnum = (v: unknown): number => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

// Build the full order detail from the Neon mirror (items, totals, dates, and the
// restaurant SNAPSHOT frozen on the order). Used for native orders and as the
// permanent fallback for FM-backed orders whose restaurant no longer resolves in
// FM — an order is a receipt of something that already happened and must always be
// viewable from captured data, independent of the restaurant's current state.
async function buildNeonDetail(nr: Record<string, unknown>): Promise<NextResponse> {
  const stRows = (await sql`
    SELECT subtotal, total, fee, own_delivery_fee, third_party_delivery_fee,
           tips_in_price, third_party_delivery_tips, state_tax, local_tax, other_tax, discount
    FROM disco_sale_transactions WHERE order_id = ${nr.id as number} ORDER BY id LIMIT 1
  `) as Array<Record<string, unknown>>
  const st = stRows[0] || {}
  const itemRows = (await sql`
    SELECT name, quantity, price_per_unit FROM disco_order_items WHERE order_id = ${nr.id as number} ORDER BY id
  `) as Array<Record<string, unknown>>
  // Restaurant block: prefer the frozen snapshot on the order, fall back to the
  // live cache (empty for a deleted restaurant → the panel shows just the order).
  const rc = (await sql`
    SELECT name, phone, timezone, address, city, state, zipcode
    FROM disco_restaurant_cache WHERE restaurant_reference = ${nr.restaurant_reference as string} LIMIT 1
  `.catch(() => [])) as Array<Record<string, unknown>>
  const r = rc[0] || {}
  const line1 = nr.delivery_address_line1 as string | null
  const detail = {
    native: !nr.fm_order_reference,
    reference: nr.reference,
    orderNumber: Number(nr.order_number) || undefined,
    orderStatus: nr.order_status,
    orderDate: nr.order_date,
    orderTime: nr.order_time,
    orderType: nr.order_type,
    deliveryType: nr.delivery_type,
    firstName: nr.customer_first_name,
    lastName: nr.customer_last_name,
    email: nr.customer_email,
    phoneNumber: nr.customer_phone,
    companyName: nr.company_name || '',
    persons: nr.persons != null ? Number(nr.persons) : undefined,
    taxExemptState: nr.tax_exempt_state || '',
    restaurant: {
      businessName: String(nr.restaurant_name || r.name || ''),
      phoneNumber: nr.restaurant_phone || r.phone || '',
      timezone: r.timezone || '',
      address: { addressLine1: nr.restaurant_address || r.address || '', city: r.city || '', state: r.state || '', zipcode: r.zipcode || '' },
    },
    deliveryAddress: line1 ? {
      addressLine1: line1, addressLine2: nr.delivery_address_line2 || '',
      city: nr.delivery_city || '', state: nr.delivery_state || '', zipcode: nr.delivery_zip || '',
    } : undefined,
    subtotal: dnum(st.subtotal ?? nr.subtotal),
    total: dnum(nr.total),
    fee: dnum(st.fee ?? nr.fee),
    ownDeliveryFee: dnum(st.own_delivery_fee),
    thirdPartyDeliveryFee: dnum(st.third_party_delivery_fee),
    tipsInPrice: dnum(st.tips_in_price ?? nr.tips),
    thirdPartyDeliveryTipsInPrice: dnum(st.third_party_delivery_tips),
    stateSalesTaxInPrice: dnum(st.state_tax),
    localSalesTaxInPrice: dnum(st.local_tax),
    otherSalesTaxInPrice: dnum(st.other_tax),
    discount: dnum(st.discount),
    refund: dnum(nr.refund),
    note: nr.note || '',
    orderMealPackages: itemRows.map((it) => ({
      name: String(it.name ?? 'Item'),
      count: Math.max(1, Math.trunc(dnum(it.quantity) || 1)),
      price: dnum(it.price_per_unit),
    })),
  }
  return NextResponse.json(detail)
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const { ref } = await params

    // Load the Neon mirror row for this order (native OR FM-backed).
    let nr: Record<string, unknown> | null = null
    if (UUID_RE.test(ref)) {
      const rows = (await sql`
        SELECT o.id, o.reference, o.fm_order_reference, o.order_number, o.order_status, o.order_type, o.delivery_type,
               o.customer_email, o.customer_first_name, o.customer_last_name, o.customer_phone,
               to_char(o.order_date,'YYYY-MM-DD') AS order_date, o.order_time::text AS order_time,
               o.subtotal, o.total, o.fee, o.tips, o.refund, o.note, o.company_name, o.persons, o.tax_exempt_state,
               o.delivery_address_line1, o.delivery_address_line2, o.delivery_city, o.delivery_state, o.delivery_zip,
               o.restaurant_reference, o.restaurant_name, o.restaurant_address, o.restaurant_phone
        FROM disco_orders o
        WHERE o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid
        LIMIT 1
      `) as Array<Record<string, unknown>>
      nr = rows[0] ?? null
    }

    // Any order present in Neon is scoped to its own customer.
    if (nr) {
      const session = await getCustomerSession(req)
      if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
      if ((session.email || '').toLowerCase() !== String(nr.customer_email || '').toLowerCase()) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 })
      }
    }

    // Native order → serve entirely from Neon.
    if (nr && !nr.fm_order_reference) return buildNeonDetail(nr)

    // ── FM-backed: try FM first (richer live data), fall back to Neon ──────────
    const token = getToken(req)
    if (token) {
      try {
        const res = await fetch(`${FM_API}/api/userOrder/${ref}`, {
          headers: { 'Authorization': token, 'Accept': 'application/json' },
        })
        if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
        if (res.ok) {
          const data = await res.json()
          // Enrich with Disco-only fields (refund, authoritative total, company,
          // headcount, tax-exempt state) so every surface matches. Best-effort.
          if (data && typeof data === 'object' && UUID_RE.test(ref)) {
            try {
              const rows = (await sql`
                SELECT o.total AS o_total, o.refund, o.company_name, o.persons, o.tax_exempt_state,
                       (SELECT MAX(sp.total) FROM disco_stripe_payments sp
                        WHERE sp.order_reference = o.reference AND sp.total IS NOT NULL AND sp.total > 0) AS sp_total
                FROM disco_orders o
                WHERE o.fm_order_reference = ${ref}::uuid OR o.reference = ${ref}::uuid
                LIMIT 1
              `) as { o_total: string | null; refund: string | null; company_name: string | null; persons: number | null; tax_exempt_state: string | null; sp_total: string | null }[]
              if (!Number(data.refund)) { const rf = Number(rows[0]?.refund); if (Number.isFinite(rf) && rf > 0) data.refund = rf }
              if (rows[0]?.company_name && !data.companyName) data.companyName = rows[0].company_name
              if (rows[0]?.persons != null && Number(rows[0].persons) > 0 && data.persons == null) data.persons = Number(rows[0].persons)
              if (rows[0]?.tax_exempt_state && !data.taxExemptState) data.taxExemptState = rows[0].tax_exempt_state
              const authTotal = Number(rows[0]?.o_total) > 0 ? Number(rows[0]?.o_total) : Number(rows[0]?.sp_total)
              if (Number.isFinite(authTotal) && authTotal > 0) data.total = authTotal
            } catch { /* best-effort enrichment */ }
          }
          return NextResponse.json(data)
        }
        // FM non-OK (e.g. the restaurant/order was deleted) → fall through to Neon.
        console.warn('[fm-order-detail] FM non-OK, falling back to Neon:', res.status, ref)
      } catch (e) {
        console.warn('[fm-order-detail] FM fetch failed, falling back to Neon:', e instanceof Error ? e.message : e)
      }
    }

    // FM couldn't serve it — the order is still a permanent receipt in Neon.
    if (nr) return buildNeonDetail(nr)
    return NextResponse.json({ error: token ? 'Order not found' : 'Not authenticated' }, { status: token ? 404 : 401 })
  } catch (err) {
    console.error('fm-order-detail error:', err)
    return NextResponse.json({ error: 'Unable to fetch order' }, { status: 500 })
  }
}
