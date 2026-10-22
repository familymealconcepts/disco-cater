import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { uploadLocationImage, clearLocationImage } from '../../../../../../lib/locations/upload-image'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/restaurant/locations/{ref}/marketplace-logo
// Multipart upload of marketplace image (4:3 cropped image).
// Forwards to FM POST /api/marketplaces/{ref}/logo
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  const ctx = await getRestaurantAuthContext()
  // KEYED ON THE LOCATION BEING ACTED ON, not on the session. `ref` is the
  // location in the URL, so its own native flag is the right discriminator —
  // a master-password FM session used to send a native location's change to
  // FamilyMeal, which does not own it.
  if (await isDiscoNativeRestaurant(ref)) return uploadLocationImage(req, ref, 'image_url', 'marketplace-logos')

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const fd = await req.formData()
    const res = await fetch(`${FM}/api/marketplaces/${ref}/logo`, {
      method: 'POST',
      headers: h,
      body: fd,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to upload marketplace logo', raw: text }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to upload marketplace logo' }, { status: 500 }) }
}

// DELETE /api/restaurant/locations/{ref}/marketplace-logo
// Removes a Disco-native location's marketplace image (disco_restaurant_cache.
// image_url → NULL). Same discriminator and auth as POST. An FM-backed location's
// image lives in FamilyMeal and removing it would be an FM write, which we never
// make — so that case is refused here rather than forwarded (the UI hides the
// control for it).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  if (await isDiscoNativeRestaurant(ref)) return clearLocationImage(ref, 'image_url')
  return NextResponse.json({ error: 'This location’s marketplace image is managed in FamilyMeal and cannot be removed here.' }, { status: 409 })
}
