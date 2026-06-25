import { NextRequest, NextResponse } from 'next/server'
import { getFmCustomerJwt } from '../../../../lib/customer-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    // Resolve the FM JWT from the Disco-native session (disco_customer_token),
    // with legacy disco_token fallback + refresh — the Stripe charge confirmation
    // fails silently otherwise (e.g. right after a native-auth signup).
    const token = await getFmCustomerJwt(req)
    if (!token) return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 })

    const body = await req.json()
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
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 })
  }
}
