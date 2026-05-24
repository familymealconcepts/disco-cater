import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const orderRef = req.nextUrl.searchParams.get('orderRef')
    if (!orderRef) return NextResponse.json({ error: 'orderRef required' }, { status: 400 })

    const res = await fetch(`${FM}/api/userOrder/${orderRef}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch order status' }, { status: 500 })
  }
}
