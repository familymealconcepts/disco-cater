import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Server-side Google Places proxy for the restaurant-edit "Fetch from Google"
// button. The legacy Places web-service endpoints (textsearch / details) do NOT
// support browser CORS, so the lookup must run server-side. We read the same
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY the client uses (also works server-side),
// falling back to the server-only Places/Maps keys.
const KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_PLACES_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY

const TEXT_SEARCH = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
const DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json'

export async function GET(req: NextRequest) {
  // Admin-only (same gate as other admin routes).
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  if (!KEY) {
    return NextResponse.json({ error: 'Google Places is not configured.' }, { status: 500 })
  }

  const sp = req.nextUrl.searchParams
  const name = (sp.get('name') || '').trim()
  const address = (sp.get('address') || '').trim()
  const query = [name, address].filter(Boolean).join(' ').trim()
  if (!query) {
    return NextResponse.json({ error: 'A restaurant name is required.' }, { status: 400 })
  }

  try {
    // 1. Text Search → first matching place.
    const tsRes = await fetch(`${TEXT_SEARCH}?query=${encodeURIComponent(query)}&key=${KEY}`)
    const ts = await tsRes.json().catch(() => null)
    const placeId = ts?.results?.[0]?.place_id as string | undefined
    if (!placeId) {
      return NextResponse.json({ error: 'No description found on Google Places' }, { status: 404 })
    }

    // 2. Place Details → editorial_summary.overview (preferred) or a fallback.
    const fields = 'editorial_summary,formatted_address,types,name'
    const dRes = await fetch(`${DETAILS}?place_id=${placeId}&fields=${fields}&key=${KEY}`)
    const d = await dRes.json().catch(() => null)
    const result = d?.result || {}

    const overview = result?.editorial_summary?.overview
    if (overview && String(overview).trim()) {
      return NextResponse.json({ description: String(overview).trim() })
    }

    // Fallback: build a short description from formatted_address + readable types.
    const types: string[] = Array.isArray(result?.types) ? result.types : []
    const readableTypes = types
      .filter(t => !['point_of_interest', 'establishment', 'food'].includes(t))
      .map(t => t.replace(/_/g, ' '))
      .slice(0, 4)
    const parts: string[] = []
    if (readableTypes.length) parts.push(readableTypes.join(', '))
    if (result?.formatted_address) parts.push(`Located at ${result.formatted_address}`)
    const fallback = parts.join('. ').trim()

    if (fallback) return NextResponse.json({ description: fallback })
    return NextResponse.json({ error: 'No description found on Google Places' }, { status: 404 })
  } catch {
    return NextResponse.json({ error: 'No description found on Google Places' }, { status: 502 })
  }
}
