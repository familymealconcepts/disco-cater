import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'
import { sql } from '../../../../lib/db'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { ref } = await params

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
