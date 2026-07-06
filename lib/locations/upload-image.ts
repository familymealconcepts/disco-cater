import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { getRestaurantAuthContext } from '../restaurant-auth-context'
import { discoGroupRefs } from '../disco-restaurant-auth'
import { sql, runMigrations } from '../db'

const IMG_MAX = 5 * 1024 * 1024
const IMG_ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

// Disco-native location image upload → Vercel Blob → a disco_restaurant_cache
// column. The 1:1 logo is icon_url; the 4:3 marketplace image is image_url.
// Group-scoped: the caller must have access to the target location. Zero FM.
export async function uploadLocationImage(
  req: NextRequest,
  ref: string,
  column: 'icon_url' | 'image_url',
  prefix: string,
): Promise<NextResponse> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)).has(ref)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return NextResponse.json({ error: 'Image storage is not configured.' }, { status: 500 })

  const fd = await req.formData()
  const file = fd.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'No image provided.' }, { status: 400 })
  if (file.size > IMG_MAX) return NextResponse.json({ error: 'Image is too large (max 5MB).' }, { status: 400 })
  if (file.type && !IMG_ALLOWED.has(file.type)) return NextResponse.json({ error: 'Unsupported image type.' }, { status: 400 })

  const safe = (file.name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  const blob = await put(`${prefix}/${ref}-${Date.now()}-${safe}`, file, { access: 'public', contentType: file.type || undefined })
  await runMigrations()
  // Column is a fixed literal (not user input) — branch so the identifier is static.
  if (column === 'icon_url') await sql`UPDATE disco_restaurant_cache SET icon_url = ${blob.url}, cached_at = NOW() WHERE restaurant_reference = ${ref}`
  else await sql`UPDATE disco_restaurant_cache SET image_url = ${blob.url}, cached_at = NOW() WHERE restaurant_reference = ${ref}`
  return NextResponse.json({ ok: true, url: blob.url })
}
