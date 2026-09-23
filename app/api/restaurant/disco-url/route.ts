import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
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
  // ── DO NOT GATE THIS ON authType === 'disco' ────────────────────────────────
  // It used to, and that is what made saving the Disco Cater URL look broken:
  // every FM-authenticated session got a flat 403 "Not authorized" here, while
  // this route's GET counterpart (disco-settings) happily served the page. So
  // the field rendered the correct slug for the correct restaurant and then
  // refused every save.
  //
  // FM sessions are the NORMAL way both the restaurant's own admin and the Disco
  // team reach a converted or duplicated location: the master password issues an
  // FM session (see lib/fm-master-admin-read.ts), and a native restaurant's
  // operator is often still an FM SYSTEM_ADMIN. Reproduced on Stacks & Cordials
  // as alex@stacksncordials.com against both Southfield (native-only, not in FM
  // at all) and Royal Oak (in FM, directly permitted) — both 403'd.
  //
  // Authorization is NOT being relaxed. requireWritableRestaurantRef below is the
  // real check and already understands both session types, including reaching a
  // Disco-native reference from an FM token via a shared multi-unit link
  // (lib/native-selection-scope.ts). This gate was a second, cruder door that
  // only ever produced false negatives. Same shape as disco-settings' PUT.
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  // Write target is the client-claimed restaurant_reference, verified against
  // the caller's permitted set — never the session's current selection (see
  // disco-profile's PUT for the full stale-intent rationale).
  const check = await requireWritableRestaurantRef(body?.restaurant_reference)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref

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
