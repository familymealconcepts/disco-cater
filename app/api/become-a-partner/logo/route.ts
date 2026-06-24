import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

// POST /api/become-a-partner/logo  (multipart: image=File)
// Uploads a partner logo/photo to Vercel Blob during onboarding. Returns { url }.
export async function POST(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Image storage is not configured.' }, { status: 500 })
  }
  try {
    const form = await req.formData()
    const file = form.get('image')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No image provided.' }, { status: 400 })
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Image is too large (max 5MB).' }, { status: 400 })
    if (file.type && !ALLOWED.has(file.type)) return NextResponse.json({ error: 'Unsupported image type.' }, { status: 400 })

    const safeName = (file.name || 'logo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
    const path = `partner-logos/${Date.now()}-${safeName}`
    const blob = await put(path, file, { access: 'public', contentType: file.type || undefined })
    return NextResponse.json({ url: blob.url })
  } catch (err) {
    console.error('[partner/logo] upload failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not upload image.' }, { status: 500 })
  }
}
