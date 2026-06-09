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

// Places API (New) endpoints — these return high-quality editorial/generative
// summaries the legacy web service does not.
const SEARCH_TEXT = 'https://places.googleapis.com/v1/places:searchText'
const PLACE_DETAILS = 'https://places.googleapis.com/v1/places'

// Places API (New) summaries are LocalizedText ({ text, languageCode }).
// generativeSummary.overview and editorialSummary are both this shape.
function textOf(v: unknown): string {
  if (!v) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'object' && v !== null && 'text' in v) {
    return String((v as { text?: unknown }).text ?? '').trim()
  }
  return ''
}

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
    // 1. Text Search (New) → first matching place id.
    const tsRes = await fetch(SEARCH_TEXT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'places.id,places.editorialSummary,places.generativeSummary,places.displayName',
      },
      body: JSON.stringify({ textQuery: query }),
    })
    const ts = await tsRes.json().catch(() => null)
    const placeId = ts?.places?.[0]?.id as string | undefined
    if (!placeId) {
      return NextResponse.json({ error: 'No editorial description available on Google Places for this restaurant.' }, { status: 404 })
    }

    // 2. Place Details (New) → editorial/generative summaries.
    const fields = 'editorialSummary,generativeSummary,displayName'
    const dRes = await fetch(`${PLACE_DETAILS}/${placeId}?fields=${fields}&key=${KEY}`)
    const place = await dRes.json().catch(() => null)

    // 3. Prefer the AI generative overview, then the human editorial summary.
    const description = textOf(place?.generativeSummary?.overview) || textOf(place?.editorialSummary)

    // 4. No quality summary available — tell the admin to write one manually
    // (no low-quality types+address fallback).
    if (!description) {
      return NextResponse.json({ error: 'No editorial description available on Google Places for this restaurant.' }, { status: 404 })
    }
    return NextResponse.json({ description })
  } catch {
    return NextResponse.json({ error: 'No editorial description available on Google Places for this restaurant.' }, { status: 502 })
  }
}
