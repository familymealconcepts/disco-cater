import { NextRequest, NextResponse } from 'next/server'

const FM = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const res = await fetch(`${FM}/api/users/payment/defaultSource`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch saved card' }, { status: 500 })
  }
}
