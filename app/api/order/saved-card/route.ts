import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const res = await fetch(`${FM}/api/users/payment/defaultSource`, {
      headers: { Accept: 'application/json', Authorization: token },
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    // FM 404 (and sometimes 204) = no card on file. That's the empty state, not
    // an error — return 200 null so the page renders a fresh Stripe Element
    // (matches fm-payment-source/route.ts).
    if (res.status === 404 || res.status === 204) return NextResponse.json(null)
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch saved card' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : null)
  } catch {
    return NextResponse.json({ error: 'Failed to fetch saved card' }, { status: 500 })
  }
}
