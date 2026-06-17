import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'

// Upload a link banner image to Vercel Blob and return its public URL. The blob
// URL becomes the source of truth for the displayed image (stored in
// disco_location_links.image_url via the PATCH .../[ref]/image endpoint); FM
// still receives a copy for its own compatibility, but we no longer read it back.
//
//   POST multipart/form-data { image: File } → { url }

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 5 * 1024 * 1024 // 5MB

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let file: File | null = null
  try {
    const form = await req.formData()
    const f = form.get('image')
    if (f && f instanceof Blob && (f as File).size > 0) file = f as File
  } catch {
    return NextResponse.json({ error: 'Invalid form data.' }, { status: 400 })
  }
  if (!file) return NextResponse.json({ error: 'An image file is required.' }, { status: 400 })
  if (file.type && !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
    return NextResponse.json({ error: 'Only image files are supported.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Image is too large (max 5MB).' }, { status: 400 })
  }

  const restaurantRef = ctx.restaurantReference || 'unknown'
  const safeName = (file.name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `link-images/${restaurantRef}/${Date.now()}-${safeName}`

  try {
    const blob = await put(path, file, { access: 'public', contentType: file.type || undefined })
    return NextResponse.json({ url: blob.url })
  } catch (e) {
    console.error('[multi-unit-links upload-image] blob put failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Image upload failed.' }, { status: 500 })
  }
}
