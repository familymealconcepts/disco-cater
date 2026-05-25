import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await req.json()

    const res = await fetch(`${FM_API}/api/users/addresses`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (res.status === 401) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to update address' }, { status: res.status })
    }

    const data = await res.json().catch(() => ({ ok: true }))
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-user-addresses error:', err)
    return NextResponse.json({ error: 'Unable to update address' }, { status: 500 })
  }
}
