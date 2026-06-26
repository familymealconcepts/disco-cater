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

    // Disco refunds live in Neon (disco_orders.refund), not on the FM order.
    // Enrich the response so the customer order detail shows the refund + net
    // total. Best-effort: only when FM didn't already report a refund.
    if (data && typeof data === 'object' && !Number(data.refund) && UUID_RE.test(ref)) {
      try {
        const rows = (await sql`
          SELECT refund FROM disco_orders
          WHERE fm_order_reference = ${ref}::uuid OR reference = ${ref}::uuid
          LIMIT 1
        `) as { refund: string | null }[]
        const r = Number(rows[0]?.refund)
        if (Number.isFinite(r) && r > 0) data.refund = r
      } catch { /* best-effort enrichment */ }
    }

    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-order-detail error:', err)
    return NextResponse.json({ error: 'Unable to fetch order' }, { status: 500 })
  }
}
