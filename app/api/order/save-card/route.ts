import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Persists a customer's card as their default payment source. Best-effort:
// called fire-and-forget after an order is already placed + paid, so a failure
// here must never look like an order failure — we always return 200 with a
// success flag the caller can ignore.
export async function POST(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) return NextResponse.json({ success: false }, { status: 200 })

    const { cardToken } = await req.json().catch(() => ({}))
    if (!cardToken) return NextResponse.json({ success: false }, { status: 200 })

    const res = await fetch(`${FM}/api/users/payment/defaultSource`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token,
      },
      body: JSON.stringify({ cardToken }),
    })

    return NextResponse.json({ success: res.ok }, { status: 200 })
  } catch {
    return NextResponse.json({ success: false }, { status: 200 })
  }
}
