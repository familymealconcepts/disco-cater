import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// Public image proxy for FM's image CDN. FM's /public-api/images/{ref}/download
// requires service auth, which a browser can't supply — so the browser hits
// this same-origin route (no auth needed by the client) and we attach the
// SUPER_ADMIN service JWT server-side and stream the bytes back. Used by the
// /locations/[slug] header (image URLs built by imageUrlFromRef).
//
//   GET /api/public/fm-image?ref=<imageRef>&size=<size>

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  const ref = (req.nextUrl.searchParams.get('ref') || '').trim()
  const sizeRaw = (req.nextUrl.searchParams.get('size') || '').trim()
  // Default 1200; only allow a plain integer size (the value goes into a URL).
  const size = /^\d+$/.test(sizeRaw) ? sizeRaw : '1200'

  if (!ref) return NextResponse.json({ error: 'ref is required' }, { status: 400 })

  let auth: Record<string, string>
  try {
    auth = await getFmServiceAuthHeader()
  } catch (e) {
    console.error('[fm-image] service auth unavailable:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Image service unavailable' }, { status: 500 })
  }

  try {
    const upstream = await fetch(
      `${FM}/public-api/images/${encodeURIComponent(ref)}/download?size=${size}`,
      { headers: { ...auth }, cache: 'no-store' },
    )
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: 'Image not found' }, { status: upstream.status || 404 })
    }
    const contentType = upstream.headers.get('content-type') || 'image/jpeg'
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (e) {
    console.error('[fm-image] fetch failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to fetch image' }, { status: 502 })
  }
}
