import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { sql } from '../../../../../../lib/db'
import { fmImageUrl } from '../../../../../../lib/fm-image'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '0j4eqnmw',
  dataset: process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  token: process.env.SANITY_TOKEN,
  useCdn: false,
})

// Marketplace image upload (4:3). FM image.service.ts:68-69 —
//   POST /api/marketplaces/{reference}/logo  (multipart FormData)
// After FM accepts the upload we also mirror the resulting public image URL into
// disco_restaurant_cache.image_url so it surfaces on the Disco fullmap (which
// reads Neon, not FM). Preferred URL is FM's own public image URL; if FM gives us
// nothing usable, we upload the same file to Sanity assets and store that URL.
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const fd = await req.formData()

    // Read the file bytes up front (for the possible Sanity fallback) WITHOUT
    // consuming `fd` — File.arrayBuffer() returns a copy, so `fd` is still intact
    // to forward to FM exactly as before.
    const file = fd.get('file')
    let buf: Buffer | null = null
    let filename = 'marketplace-image'
    let contentType = 'image/jpeg'
    if (file instanceof File) {
      buf = Buffer.from(await file.arrayBuffer())
      filename = file.name || filename
      contentType = file.type || contentType
    }

    const res = await fetch(`${FM}/api/marketplaces/${ref}/logo`, { method: 'POST', headers: h, body: fd })
    if (!res.ok) { const raw = await res.text().catch(() => ''); return NextResponse.json({ error: 'Failed to upload marketplace image', raw }, { status: res.status }) }
    const text = await res.text()
    const fmJson = text ? JSON.parse(text) : { ok: true }

    // 1) Prefer a public URL derived from FM's response.
    let imageUrl = fmImageUrl(fmJson)

    // 2) Fall back to Sanity's asset CDN when FM didn't return anything usable.
    if (!imageUrl && buf && process.env.SANITY_TOKEN) {
      try {
        const asset = await sanity.assets.upload('image', buf, { filename, contentType })
        imageUrl = asset.url
      } catch (e) {
        console.error('[marketplace-image] Sanity fallback upload failed:', e instanceof Error ? e.message : e)
      }
    }

    // 3) Mirror the URL into the Neon cache so the fullmap shows it. Non-fatal:
    // the FM upload already succeeded, so a Neon hiccup shouldn't fail the request.
    if (imageUrl) {
      try {
        await sql`
          UPDATE disco_restaurant_cache
          SET image_url = ${imageUrl}, cached_at = NOW()
          WHERE restaurant_reference = ${ref}
        `
      } catch (e) {
        console.error('[marketplace-image] Neon image_url write failed:', e instanceof Error ? e.message : e)
      }
    } else {
      console.warn(`[marketplace-image] No usable image URL for ${ref}; cache image_url left unchanged.`)
    }

    return NextResponse.json(fmJson)
  } catch { return NextResponse.json({ error: 'Unable to upload marketplace image' }, { status: 500 }) }
}
