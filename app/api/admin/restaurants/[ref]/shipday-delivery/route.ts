import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// "Shipday Delivery" toggle.
// ⚠️ UNVERIFIED: my FM source copy only has a single `shipdayEnabled` toggle
// (restaurant.service.ts:317). Production FM reportedly split it into Delivery
// + Pickup; the field name `shipdayDeliveryEnabled` and this endpoint shape are
// modeled on the existing shipdayEnabled pattern and may need correcting once
// the real FM endpoint is confirmed. See audit doc Part A note.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  const enabled = req.nextUrl.searchParams.get('shipdayDeliveryEnabled') || 'false'
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}/shipdayDeliveryEnabled?shipdayDeliveryEnabled=${enabled}`, { method: 'PATCH', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update Shipday delivery' }, { status: 500 }) }
}
