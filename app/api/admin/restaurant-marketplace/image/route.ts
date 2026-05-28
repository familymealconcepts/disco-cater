import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '0j4eqnmw',
  dataset: process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  token: process.env.SANITY_TOKEN,
  useCdn: false,
})

// Uploads a hero image to Sanity's asset store and returns an image field
// object ready to drop into the restaurant doc's `image` field.
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
    return NextResponse.json({
      image: { _type: 'image', asset: { _type: 'reference', _ref: asset._id } },
      url: asset.url,
    })
  } catch (e) {
    return NextResponse.json({ error: 'Sanity image upload failed', detail: String(e) }, { status: 500 })
  }
}
