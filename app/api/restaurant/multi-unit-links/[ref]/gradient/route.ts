import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { upsertLinkGradientOverride } from '../../../../../../lib/location-links'

// PATCH .../multi-unit-links/[ref]/gradient — set (or clear) the manual header
// gradient override for a link's Neon mirror row. The public /locations/[slug]
// page prefers this override over the auto-extracted brand gradient. Body:
//   { slug, gradient?: string | null }  — a CSS gradient string, or empty/null to
// clear and fall back to the auto/generic gradient. The [ref] segment is for
// routing only; the row is keyed by slug. Gated on a valid restaurant session.
export async function PATCH(req: NextRequest) {
  try { await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let slug = ''
  let gradient: string | null = null
  try {
    const body = await req.json()
    slug = String(body?.slug || '').trim()
    const raw = body?.gradient
    gradient = raw == null || String(raw).trim() === '' ? null : String(raw).trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (!slug) return NextResponse.json({ error: 'slug is required.' }, { status: 400 })

  // Only accept a CSS gradient/color value — never arbitrary CSS (this string is
  // interpolated into the header's `background`). Keep it to gradient()/rgb()/hex.
  if (gradient && !/^(linear-gradient|radial-gradient|#[0-9a-fA-F]{3,8}|rgb)/.test(gradient)) {
    return NextResponse.json({ error: 'gradient must be a CSS gradient or color.' }, { status: 400 })
  }
  if (gradient && (gradient.includes(';') || gradient.includes('}') || gradient.includes('url('))) {
    return NextResponse.json({ error: 'invalid gradient value.' }, { status: 400 })
  }

  try {
    await upsertLinkGradientOverride(slug, gradient)
    return NextResponse.json({ ok: true, slug, gradient })
  } catch (e) {
    console.error('[multi-unit-links gradient] upsert failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update gradient' }, { status: 500 })
  }
}
