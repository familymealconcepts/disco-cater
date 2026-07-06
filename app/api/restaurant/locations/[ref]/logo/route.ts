import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { uploadLocationImage } from '../../../../../../lib/locations/upload-image'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/restaurant/locations/{ref}/logo
// Multipart upload of restaurant logo (1:1 cropped image).
// Forwards to FM POST /api/restaurants/{ref}/logo
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return uploadLocationImage(req, ref, 'icon_url', 'restaurant-logos')

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const fd = await req.formData()
    const res = await fetch(`${FM}/api/restaurants/${ref}/logo`, {
      method: 'POST',
      headers: h,
      body: fd,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to upload logo', raw: text }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to upload logo' }, { status: 500 }) }
}
