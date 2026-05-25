import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM_API = 'https://api.familymeal.com'

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { ref } = await params

    const res = await fetch(`${FM_API}/api/userOrder/${ref}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    })

    if (res.status === 401) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch order' }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-order-detail error:', err)
    return NextResponse.json({ error: 'Unable to fetch order' }, { status: 500 })
  }
}
