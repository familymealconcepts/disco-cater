import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Server-side Sanity client with write token. SANITY_TOKEN is server-only
// (never NEXT_PUBLIC) so all writes must go through this route.
const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '0j4eqnmw',
  dataset: process.env.SANITY_DATASET || process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  token: process.env.SANITY_TOKEN,
  useCdn: false,
})

// Editable Marketplace fields. `fmReference` ties the Sanity doc to the FM
// restaurant and must exist on the Sanity `restaurant` schema (in the hosted
// Studio repo) — see audit doc Part B.3.
const FIELDS = ['cuisines', 'description', 'location', 'lat', 'lng', 'orderUrl', 'isDisco', 'image', 'name'] as const

export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const fmReference = req.nextUrl.searchParams.get('fmReference')
  if (!fmReference) return NextResponse.json({ error: 'fmReference required' }, { status: 400 })
  try {
    const doc = await sanity.fetch(
      `*[_type == "restaurant" && fmReference == $ref][0]`,
      { ref: fmReference },
    )
    return NextResponse.json(doc || null)
  } catch (e) {
    return NextResponse.json({ error: 'Sanity fetch failed', detail: String(e) }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  if (!process.env.SANITY_TOKEN) {
    return NextResponse.json({ error: 'SANITY_TOKEN not configured on the server' }, { status: 500 })
  }
  try {
    const body = await req.json()
    const fmReference: string = body.fmReference
    if (!fmReference) return NextResponse.json({ error: 'fmReference required' }, { status: 400 })

    // Only persist known fields.
    const fields: Record<string, unknown> = {}
    for (const k of FIELDS) if (body[k] !== undefined) fields[k] = body[k]

    const existing = await sanity.fetch(`*[_type == "restaurant" && fmReference == $ref][0]{ _id }`, { ref: fmReference })
    if (existing?._id) {
      const res = await sanity.patch(existing._id).set(fields).commit()
      return NextResponse.json(res)
    }
    // Create a new doc. Deterministic id keeps re-saves idempotent.
    const res = await sanity.createOrReplace({
      _id: `restaurant.fm-${fmReference}`,
      _type: 'restaurant',
      fmReference,
      ...fields,
    })
    return NextResponse.json(res)
  } catch (e) {
    return NextResponse.json({ error: 'Sanity write failed', detail: String(e) }, { status: 500 })
  }
}
