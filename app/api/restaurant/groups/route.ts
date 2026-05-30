import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

async function auth() { return getRestaurantAuthHeader() }

// List GET intentionally NOT here — FM has no /api/extraItemsGroups list
// endpoint; use /api/restaurant/groups/list which forwards to the restaurant-
// scoped /api/restaurants/{ref}/extraItemsGroups instead. POST (create) below
// correctly hits the bare /api/extraItemsGroups path FM does expose.
export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/extraItemsGroups`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to create' }, { status: 500 }) }
}
