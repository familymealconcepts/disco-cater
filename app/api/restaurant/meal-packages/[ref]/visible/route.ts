import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

async function auth() { return getRestaurantAuthHeader() }

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  const isVisible = req.nextUrl.searchParams.get('isVisible') || 'true'
  try {
    const res = await fetch(`${FM}/api/mealPackages/${ref}/visible?isVisible=${isVisible}`, {
      method: 'PUT',
      headers: h,
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update visibility' }, { status: 500 }) }
}
