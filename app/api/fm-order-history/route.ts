import { NextRequest, NextResponse } from 'next/server'
import { getFmCustomerJwt, getCustomerSession } from '../../../lib/customer-auth'
import { sql } from '../../../lib/db'
import { fmFetch } from '../../../lib/fm-fetch'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

type AnyOrder = Record<string, unknown>
function dateKey(o: AnyOrder): number {
  const d = new Date(String(o.orderDate || o.deliveryDate || o.date || o.createdAt || '') || 0)
  const t = d.getTime()
  return Number.isFinite(t) ? t : 0
}
function refKey(o: AnyOrder): string {
  return String(o.reference || o.orderReference || o.id || o.orderNumber || '').toLowerCase()
}

// Customer order history. FM (GET /api/userOrder) is best-effort — it has been
// flaky/401. We always also read the Neon mirror (disco_orders) by customer
// email and merge, so Disco-native orders show even when FM is down or returns
// nothing. Combined list is sorted by order date DESC.
export async function GET(req: NextRequest) {
  const session = await getCustomerSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 })
  }
  const email = session.email

  const { searchParams } = req.nextUrl
  const page = searchParams.get('page') || '0'
  const size = searchParams.get('size') || '50'

  // 1) FM (best-effort).
  let fmList: AnyOrder[] = []
  try {
    const token = await getFmCustomerJwt(req)
    if (token) {
      const res = await fmFetch(`${FM_API}/api/userOrder?page=${page}&size=${size}`, {
        headers: { Authorization: token, Accept: 'application/json' },
      })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        fmList = (data?.content || data?.orders || data?.data || (Array.isArray(data) ? data : [])) as AnyOrder[]
      } else {
        console.warn('[fm-order-history] FM non-OK (falling back to Neon):', res.status)
      }
    }
  } catch (err) {
    console.error('[fm-order-history] FM fetch failed (falling back to Neon):', err instanceof Error ? err.message : err)
  }

  // 2) Neon mirror by customer email.
  let neonList: AnyOrder[] = []
  try {
    const rows = (await sql`
      SELECT fm_order_reference, reference, order_number, order_status, order_type, source_of_order,
             restaurant_name, to_char(order_date,'YYYY-MM-DD') AS order_date, total, created_at
      FROM disco_orders
      WHERE customer_email = ${email} AND COALESCE(is_deleted, false) = false
      ORDER BY order_date DESC, order_time DESC
      LIMIT 100
    `.catch(() => [])) as Array<{
      fm_order_reference: string | null; reference: string; order_number: string
      order_status: string; order_type: string; source_of_order: string
      restaurant_name: string | null; order_date: string; total: string | null; created_at: string | null
    }>
    neonList = rows.map(r => ({
      reference: r.fm_order_reference || r.reference,
      orderNumber: Number(r.order_number),
      restaurantName: r.restaurant_name || undefined,
      orderDate: r.order_date,
      orderStatus: r.order_status,
      orderType: r.order_type,
      sourceoforder: r.source_of_order,
      total: num(r.total),
      createdAt: r.created_at || undefined,
    }))
  } catch (err) {
    console.error('[fm-order-history] Neon read failed:', err instanceof Error ? err.message : err)
  }

  // 3) Merge: keep all FM results, add any Neon order not already present, sort DESC.
  const seen = new Set(fmList.map(refKey).filter(Boolean))
  const merged: AnyOrder[] = [...fmList]
  for (const o of neonList) {
    const k = refKey(o)
    if (!k || !seen.has(k)) { merged.push(o); if (k) seen.add(k) }
  }
  merged.sort((a, b) => dateKey(b) - dateKey(a))

  return NextResponse.json({ content: merged, totalElements: merged.length })
}
