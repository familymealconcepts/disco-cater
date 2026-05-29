import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await req.json()
    console.log('[confirm-payment] body →' + JSON.stringify(body, null, 2))
    const res = await fetch(`${FM}/api/userOrder/confirmPayment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    console.log('[confirm-payment] FM response →', res.status, JSON.stringify(data, null, 2))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 })
  }
}
