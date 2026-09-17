import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { uploadLocationImage } from '../../../../../../lib/locations/upload-image'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Restaurant logo upload (1:1). FM image.service.ts:56-57 —
//   POST /api/restaurants/{reference}/logo  (multipart FormData)
//
// A Disco-native restaurant's logo is Disco's own (Blob + icon_url on
// disco_restaurant_cache); sending it to FamilyMeal put the file somewhere no
// Disco surface reads. The restaurant portal already does this correctly
// (app/api/restaurant/locations/[ref]/logo) — the admin portal now shares it,
// rather than uploading to a second place.
//
// uploadLocationImage takes the ref explicitly, so the file lands on the
// restaurant named in the URL and never on whatever happens to be selected
// elsewhere — the session-based targeting bug that mis-assigned a logo before.
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params

  if (await isDiscoNativeRestaurant(ref)) return uploadLocationImage(req, ref, 'icon_url', 'restaurant-logos')

  try {
    const fd = await req.formData()
    const res = await fetch(`${FM}/api/restaurants/${ref}/logo`, { method: 'POST', headers: h, body: fd })
    if (!res.ok) { const raw = await res.text().catch(() => ''); return NextResponse.json({ error: 'Failed to upload logo', raw }, { status: res.status }) }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to upload logo' }, { status: 500 }) }
}
