import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Reorder a system-admin restaurant "location". This matches FM's own
// locations page exactly: restaurant.service.ts:200 updatePosition() →
// PUT /api/system-admin/restaurants/{ref}/position?position=N with a null body.
// (There is no addresses/{ref}/position endpoint — FM models each location as a
// system-admin restaurant entity, reordered by this call.)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const position = req.nextUrl.searchParams.get('position') || '0'
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}/position?position=${position}`, { method: 'PUT', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update position' }, { status: 500 }) }
}
