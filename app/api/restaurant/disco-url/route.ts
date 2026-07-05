import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Slug rules (same shape as menu URLs + the FM order-settings slug rule): lowercase
// letters/numbers/hyphens, 3–60 chars, no leading/trailing hyphen.
function slugError(s: string): string | null {
  if (s.length < 3) return 'URL must be at least 3 characters.'
  if (s.length > 60) return 'URL must be at most 60 characters.'
  if (!/^[a-z0-9-]+$/.test(s)) return 'URL can only contain lowercase letters, numbers, and hyphens.'
  if (s.startsWith('-') || s.endsWith('-')) return 'URL cannot start or end with a hyphen.'
  return null
}

// Update a Disco-native restaurant's public Disco Cater URL slug
// (discocater.com/restaurants/{slug}) in Neon. Unique across all cached restaurants
// (case-insensitive) — same intent as the FM "unique across all restaurants" rule
// and the menu-URL collision check. Zero FM.
export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType !== 'disco') return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const slug = String(body?.slug || '').trim().toLowerCase()
  const err = slugError(slug)
  if (err) return NextResponse.json({ error: err }, { status: 400 })

  await runMigrations()
  // Global uniqueness, case-insensitive, excluding this restaurant.
  const taken = (await sql`
    SELECT 1 FROM disco_restaurant_cache WHERE LOWER(slug) = ${slug} AND restaurant_reference <> ${ref} LIMIT 1
  `) as unknown[]
  if (taken.length) return NextResponse.json({ error: 'That URL is already taken. Choose another.' }, { status: 409 })

  await sql`UPDATE disco_restaurant_cache SET slug = ${slug}, cached_at = NOW() WHERE restaurant_reference = ${ref}`
  return NextResponse.json({ ok: true, slug })
}
