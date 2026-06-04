import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM filters orders by fromDate/toDate formatted DD.MM.YYYY (known FM gotcha —
// same as the customers endpoint). The date inputs send ISO YYYY-MM-DD, so
// convert before forwarding or FM returns an empty list.
function toFmDate(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  if (sp.get('search')) params.set('search', sp.get('search')!)
  const fromDate = toFmDate(sp.get('fromDate'))
  const toDate = toFmDate(sp.get('toDate'))
  if (fromDate) params.set('fromDate', fromDate)
  if (toDate) params.set('toDate', toDate)
  sp.getAll('orderStatuses').forEach(s => params.append('orderStatuses', s))
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/admin/userOrders?${params}`, { headers: h })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error(`[admin/orders] FM ${res.status} for ?${params} — ${raw.slice(0, 300)}`)
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: res.status })
    }
    const data = await res.json()
    const count = Array.isArray(data?.content) ? data.content.length : (Array.isArray(data) ? data.length : 0)
    // Diagnostic: how the FM pagination envelope looks per page fetch.
    console.log(`[admin/orders] page=${page || '0'} size=${params.get('size')} → ${count} orders (totalElements=${data?.totalElements ?? data?.total_elements ?? 'n/a'}, totalPages=${data?.totalPages ?? data?.total_pages ?? 'n/a'})`)
    if (count === 0) {
      console.error(`[admin/orders] FM returned 0 orders for ?${params} (totalElements=${data?.totalElements ?? 'n/a'})`)
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[admin/orders] FM request failed:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
