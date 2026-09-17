import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { nativeOnlyRestaurants } from '../../../../../lib/admin/native-restaurant-merge'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// The Marketplace list proxies FamilyMeal's marketplace endpoint, so a
// restaurant created natively on Disco Cater never appeared on it — while being
// live on Disco's actual marketplace. Native rows are prepended on the FIRST
// page only, the same pattern the Orders list uses.
//
// `blocked` for a native row is derived from disco_restaurant_cache.is_live, the
// flag Disco's marketplace feed actually reads — NOT from FM's blocked column,
// which does not govern these restaurants. The row's block toggle posts to
// /api/admin/restaurants/[ref]/block, which now writes that same flag, so what
// the checkbox shows and what it sets are the one thing.

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
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/marketplace?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch marketplace restaurants' }, { status: res.status })
    const data = await res.json()

    if (!page || page === '0') {
      const native = (await nativeOnlyRestaurants(sp.get('search'), 200)).map(r => ({
        reference: r.reference,
        businessName: r.businessName,
        blocked: !r.isLive,
        createdDate: r.createdDate,
        native: true,
      }))
      if (native.length && data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).content)) {
        const d = data as Record<string, unknown>
        d.content = [...native, ...(d.content as unknown[])]
        if (typeof d.totalElements === 'number') d.totalElements += native.length
      }
    }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch marketplace restaurants' }, { status: 500 })
  }
}
