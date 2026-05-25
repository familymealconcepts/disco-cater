import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantToken } from '../../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const token = getRestaurantToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const res = await fetch(`${FM}/api/restaurant/orders/${ref}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to confirm order', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (err) {
    console.error('restaurant/orders/[ref]/confirm error:', err)
    return NextResponse.json({ error: 'Unable to confirm order' }, { status: 500 })
  }
}
