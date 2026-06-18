import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Counts how many locations FM actually serves PUBLICLY for a link's slug —
// i.e. what /locations/[slug] would render. Proxies FM's public group endpoint
// (no auth) and flattens groups[].restaurants[] exactly like lib/locations.ts.
//
//   GET /api/restaurant/multi-unit-links/live-count?slug=xxx → { slug, liveCount }
export async function GET(req: NextRequest) {
  const slug = (req.nextUrl.searchParams.get('slug') || '').trim()
  if (!slug) return NextResponse.json({ slug: '', liveCount: 0 })

  try {
    const res = await fetch(`${FM}/public-api/restaurants/group/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) return NextResponse.json({ slug, liveCount: 0 }) // 404 = no live group

    const groups = (await res.json().catch(() => null)) as { restaurants?: unknown[] }[] | null
    if (!Array.isArray(groups)) return NextResponse.json({ slug, liveCount: 0 })

    let liveCount = 0
    for (const g of groups) if (Array.isArray(g?.restaurants)) liveCount += g.restaurants.length

    return NextResponse.json({ slug, liveCount })
  } catch {
    return NextResponse.json({ slug, liveCount: 0 })
  }
}
