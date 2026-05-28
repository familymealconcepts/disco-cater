import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// "Shipday Pickup" toggle.
// ⚠️ UNVERIFIED: see shipday-delivery/route.ts. My FM source only has a single
// `shipdayEnabled` toggle; `shipdayPickupEnabled` is a modeled guess pending
// confirmation against production FM. See audit doc Part A note.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  const enabled = req.nextUrl.searchParams.get('shipdayPickupEnabled') || 'false'
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}/shipdayPickupEnabled?shipdayPickupEnabled=${enabled}`, { method: 'PATCH', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update Shipday pickup' }, { status: 500 }) }
}
