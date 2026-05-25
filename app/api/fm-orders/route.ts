import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'

const FM_API = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    let res = await fetch(`${FM_API}/api/userOrder?page=0&size=50`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    })

    // If 401, try refresh then retry
    if (res.status === 401) {
      const refreshRes = await fetch(`${req.nextUrl.origin}/api/auth/refresh`, {
        method: 'POST',
        headers: { cookie: req.headers.get('cookie') || '' },
      })
      if (refreshRes.ok) {
        // Can't re-read the cookie in the same request — return 401 so client retries
        return NextResponse.json({ error: 'Token refreshed, please retry' }, { status: 401 })
      }
      return NextResponse.json({ error: 'Session expired' }, { status: 401 })
    }

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch orders', status: res.status }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-orders error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
