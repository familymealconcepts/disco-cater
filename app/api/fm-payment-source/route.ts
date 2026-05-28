import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const res = await fetch(`${FM_API}/api/users/payment/defaultSource`, {
      headers: {
        'Authorization': token,
        'Accept': 'application/json',
      },
    })

    if (res.status === 401) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch payment source' }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-payment-source GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch payment source' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await req.json()

    // FM expects `{ cardToken }` (account.service.ts:126-128). Normalize
    // defensively: accept either `cardToken` or a legacy `token` field
    // and always forward FM's expected `cardToken`. Carry any other
    // fields through untouched.
    const cardToken = body?.cardToken ?? body?.token
    const fmBody = { ...body, cardToken }
    delete (fmBody as Record<string, unknown>).token

    const res = await fetch(`${FM_API}/api/users/payment/defaultSource`, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fmBody),
    })

    if (res.status === 401) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to update payment source' }, { status: res.status })
    }

    const data = await res.json().catch(() => ({ ok: true }))
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-payment-source POST error:', err)
    return NextResponse.json({ error: 'Unable to update payment source' }, { status: 500 })
  }
}
