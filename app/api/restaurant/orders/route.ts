import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  params.set('page', sp.get('page') || '0')
  params.set('size', sp.get('size') || '25')
  sp.getAll('orderStatuses').forEach(s => params.append('orderStatuses', s))
  sp.getAll('sort').forEach(s => params.append('sort', s))
  if (sp.get('search')) params.set('search', sp.get('search')!)
  if (sp.get('fromDate')) params.set('fromDate', sp.get('fromDate')!)
  if (sp.get('toDate')) params.set('toDate', sp.get('toDate')!)

  try {
    const res = await fetch(`${FM}/api/orders?${params}`, { headers: authHeaders })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to fetch orders', raw: err }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('restaurant/orders GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
