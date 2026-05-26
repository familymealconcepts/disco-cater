import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

async function auth() { return getRestaurantAuthHeader() }

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/menu/${ref}`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update menu settings' }, { status: 500 }) }
}
