import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Generic image-asset upload: stores the file in Sanity's asset CDN and returns
// its public URL. Used by the restaurant edit dialog to host the map image,
// whose URL is then saved to disco_restaurant_cache.image_url. Admin-cookie gated.

export const runtime = 'nodejs'

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '0j4eqnmw',
  dataset: process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  token: process.env.SANITY_TOKEN,
  useCdn: false,
})

export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  if (!process.env.SANITY_TOKEN) {
    return NextResponse.json({ error: 'SANITY_TOKEN not configured on the server' }, { status: 500 })
  }
  try {
    const fd = await req.formData()
    const file = fd.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
    const buffer = Buffer.from(await file.arrayBuffer())
    const asset = await sanity.assets.upload('image', buffer, { filename: file.name, contentType: file.type })
    return NextResponse.json({ url: asset.url })
  } catch (e) {
    return NextResponse.json({ error: 'Asset upload failed', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
