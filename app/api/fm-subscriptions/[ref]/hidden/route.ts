import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PUT /api/fm-subscriptions/{ref}/hidden — archives the subscription from
// the diner's view. Proxies FM PUT /api/userOrderSubscription/{ref}/hidden.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ref } = await params
  try {
    const res = await fetch(`${FM_API}/api/userOrderSubscription/${ref}/hidden`, {
      method: 'PUT',
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to archive subscription' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to archive subscription' }, { status: 500 })
  }
}
