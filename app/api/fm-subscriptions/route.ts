import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/fm-subscriptions — list this diner's recurring orders.
// Proxies FM GET /api/userOrderSubscription (paginated). Raw JWT, no Bearer.
export async function GET(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '50')
  sp.getAll('sort').forEach(s => params.append('sort', s))

  try {
    const res = await fetch(`${FM_API}/api/userOrderSubscription?${params}`, {
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch subscriptions', status: res.status, raw }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch subscriptions' }, { status: 500 })
  }
}
