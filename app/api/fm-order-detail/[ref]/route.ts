import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'
import { getCustomerSession } from '../../../../lib/customer-auth'
import { sql } from '../../../../lib/db'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const dnum = (v: unknown): number => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const { ref } = await params

    // ── Disco-native branch ─────────────────────────────────────────────────
    // Native orders (fm_order_reference IS NULL) aren't on FamilyMeal, so the FM
    // fetch below 404s and the detail panel errored. Serve from Neon, authed by
    // the customer session and scoped to that customer. FM-backed orders fall
    // through to the unchanged FM path (which uses the legacy getToken).
    if (UUID_RE.test(ref)) {
      const nativeRows = (await sql`
        SELECT o.id, o.reference, o.order_number, o.order_status, o.order_type, o.delivery_type,
               o.customer_email, o.customer_first_name, o.customer_last_name, o.customer_phone,
               to_char(o.order_date,'YYYY-MM-DD') AS order_date, o.order_time::text AS order_time,
               o.subtotal, o.total, o.fee, o.tips, o.refund, o.note, o.company_name, o.persons,
               o.tax_exempt_state,
               o.delivery_address_line1, o.delivery_address_line2, o.delivery_city, o.delivery_state, o.delivery_zip,
               o.restaurant_reference, o.restaurant_name
        FROM disco_orders o
        WHERE (o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid)
          AND o.fm_order_reference IS NULL
        LIMIT 1
      `) as Array<Record<string, unknown>>
      const nr = nativeRows[0]
      if (nr) {
        const session = await getCustomerSession(req)
        if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
        if ((session.email || '').toLowerCase() !== String(nr.customer_email || '').toLowerCase()) {
          return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }
        const stRows = (await sql`
          SELECT subtotal, total, fee, own_delivery_fee, third_party_delivery_fee,
                 tips_in_price, third_party_delivery_tips, state_tax, local_tax, other_tax, discount
          FROM disco_sale_transactions WHERE order_id = ${nr.id as number} ORDER BY id LIMIT 1
        `) as Array<Record<string, unknown>>
        const st = stRows[0] || {}
        const itemRows = (await sql`
          SELECT name, quantity, price_per_unit FROM disco_order_items WHERE order_id = ${nr.id as number} ORDER BY id
        `) as Array<Record<string, unknown>>
        const rc = (await sql`
          SELECT name, phone, timezone, address, city, state, zipcode
          FROM disco_restaurant_cache WHERE restaurant_reference = ${nr.restaurant_reference as string} LIMIT 1
        `) as Array<Record<string, unknown>>
        const r = rc[0] || {}
        const line1 = nr.delivery_address_line1 as string | null
        const detail = {
          native: true,
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
            businessName: String(r.name || nr.restaurant_name || ''),
            phoneNumber: r.phone || '',
            timezone: r.timezone || '',
            address: { addressLine1: r.address || '', city: r.city || '', state: r.state || '', zipcode: r.zipcode || '' },
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
    }

    // ── FM-backed path (unchanged) ──────────────────────────────────────────
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const res = await fetch(`${FM_API}/api/userOrder/${ref}`, {
      headers: {
        'Authorization': token,
        'Accept': 'application/json',
      },
    })

    if (res.status === 401) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch order' }, { status: res.status })
    }

    const data = await res.json()

    // Disco-only fields live in Neon (not on the FM order): refund, the
    // authoritative total (the actual charge, already tax-exempt-reduced), company
    // name, headcount, and tax-exempt state. Enrich the response so the customer
    // order detail matches the other surfaces. Best-effort.
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
        if (!Number(data.refund)) {
          const r = Number(rows[0]?.refund)
          if (Number.isFinite(r) && r > 0) data.refund = r
        }
        if (rows[0]?.company_name && !data.companyName) data.companyName = rows[0].company_name
        if (rows[0]?.persons != null && Number(rows[0].persons) > 0 && data.persons == null) data.persons = Number(rows[0].persons)
        if (rows[0]?.tax_exempt_state && !data.taxExemptState) data.taxExemptState = rows[0].tax_exempt_state
        // Authoritative total: disco_orders.total → Stripe payment total. Overrides
        // FM's tax-inclusive total so every surface shows the same charged amount.
        const authTotal = Number(rows[0]?.o_total) > 0 ? Number(rows[0]?.o_total) : Number(rows[0]?.sp_total)
        if (Number.isFinite(authTotal) && authTotal > 0) data.total = authTotal
      } catch { /* best-effort enrichment */ }
    }

    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-order-detail error:', err)
    return NextResponse.json({ error: 'Unable to fetch order' }, { status: 500 })
  }
}
