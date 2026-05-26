import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const res = await fetch(`${FM_API}/api/users`, {
      headers: {
        'Authorization': token,
        'Accept': 'application/json',
      },
    })

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch profile' }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-user error:', err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await req.json()

    const res = await fetch(`${FM_API}/api/users`, {
      method: 'PUT',
      headers: {
        'Authorization': token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to update profile' }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-user PUT error:', err)
    return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
  }
}
