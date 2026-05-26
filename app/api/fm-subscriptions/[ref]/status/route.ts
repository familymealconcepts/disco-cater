import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PUT /api/fm-subscriptions/{ref}/status?status=ACTIVE|PAUSED|CANCELED&restaurantReference=X
// Proxies FM PUT /api/userOrderSubscription/{ref}/updateStatus?restaurantReference=&subscriptionStatus=
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ref } = await params
  const status = req.nextUrl.searchParams.get('status')
  const restaurantRef = req.nextUrl.searchParams.get('restaurantReference')
  if (!status || !restaurantRef) {
    return NextResponse.json({ error: 'status and restaurantReference required' }, { status: 400 })
  }

  const fmUrl = `${FM_API}/api/userOrderSubscription/${ref}/updateStatus`
    + `?restaurantReference=${encodeURIComponent(restaurantRef)}`
    + `&subscriptionStatus=${encodeURIComponent(status)}`

  try {
    const res = await fetch(fmUrl, {
      method: 'PUT',
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to update subscription status', raw }, { status: res.status })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update subscription status' }, { status: 500 })
  }
}
