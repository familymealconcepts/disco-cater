import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'
import { sql } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const orderRef = req.nextUrl.searchParams.get('orderRef')
    if (!orderRef) return NextResponse.json({ error: 'orderRef required' }, { status: 400 })

    const res = await fetch(`${FM}/api/userOrder/${orderRef}`, {
      headers: { Accept: 'application/json', Authorization: token },
    })
    const data = await res.json()

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

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch order status' }, { status: 500 })
  }
}
