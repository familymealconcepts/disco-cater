import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/customer/restaurant-logos?names=Botte%20-%20UES|Two%20Hands%20-%20NoHo
//   → { logos: { "botte - ues": "https://…" } }   (keys are lower-cased names)
//
// ONE request for a whole calendar month, not one per order. The diner order
// history (/api/fm-order-history) returns restaurant_name and no reference, and
// that payload is deliberately left alone, so the join is by name.
//
// icon_url is the logo the rest of the app already uses — the square image the
// restaurant uploads on its profile page (image_url is the wider marketplace
// photo, which is the wrong shape for an avatar). No new field.
//
// Display-only and read-only: nothing here writes, and nothing it returns
// affects which orders a diner sees.
export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get('names') || '')
    .split('|').map(s => s.trim()).filter(Boolean)
  const names = [...new Set(raw.map(n => n.toLowerCase()))].slice(0, 60)
  if (!names.length) return NextResponse.json({ logos: {} })

  try {
    // DISTINCT ON with a deterministic tiebreak: some names repeat in the cache
    // (blasteran ×3, repro test restaurant ×3), and picking arbitrarily would
    // make a restaurant's avatar flicker between months. Prefer a row that
    // actually has a logo, then the oldest.
    const rows = (await sql`
      SELECT DISTINCT ON (LOWER(name)) LOWER(name) AS key, icon_url
      FROM disco_restaurant_cache
      WHERE LOWER(name) = ANY(${names}::text[])
      ORDER BY LOWER(name), (icon_url IS NULL), restaurant_reference
    `) as { key: string; icon_url: string | null }[]

    const logos: Record<string, string> = {}
    for (const r of rows) if (r.icon_url) logos[r.key] = r.icon_url
    return NextResponse.json({ logos })
  } catch (e) {
    // A missing logo is decoration — the calendar falls back to monograms. Say
    // so rather than 500ing a page that renders fine without this.
    console.error('[restaurant-logos] lookup failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ logos: {}, degraded: true })
  }
}
