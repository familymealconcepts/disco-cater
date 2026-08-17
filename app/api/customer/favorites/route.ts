import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../lib/customer-auth'
import { sql, withDiscoTables } from '../../../../lib/db'
// Note: the GET hot-path deliberately does NOT call runDiscoOrderMigrations() —
// the tables already exist in production and the per-request ~60-statement
// migration run was the dominant favorites-load latency. Migrations run via
// runMigrations()/runDiscoOrderMigrations() on other (cold-start) routes.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/customer/favorites
// Cross-device favorites for the logged-in customer (from the disco_customer_token
// session). Returns { authenticated, email, favorites: FavoriteRestaurant[] } —
// each favorite is ENRICHED from disco_restaurant_cache (name, image, slug,
// cuisine, location) by a LEFT JOIN, so the favorites grid + calendar picker can
// render the real restaurant card without relying on a local-device cache. When
// not logged in, returns authenticated:false + an empty list (never errors).
export async function GET(req: NextRequest) {
  const session = await getCustomerSession(req)
  if (!session) {
    console.log('[customer/favorites] GET — no session (disco_customer_token missing/expired)')
    return NextResponse.json({ authenticated: false, favorites: [] })
  }
  try {
    // Enrich via TWO joins: by restaurant_reference (UUID-stored favorites) and by
    // slug (legacy slug-stored favorites). COALESCE so either match populates the
    // card, and surface the canonical UUID so the client stores/deletes by UUID.
    //
    // Status filter (previously missing entirely — a favorited restaurant that
    // went is_live=false already rendered a normal-looking card that 404'd on
    // click). Two exclusions, both matching the discovery-feed rule in
    // lib/marketplace-restaurants.ts:
    //   • archived_at IS NOT NULL — the new, stronger gate (Disco-native only;
    //     harmless no-op for FM-backed rows, which never get archived_at set).
    //   • is_disco_native = true AND is_live = false — is_live is only a
    //     reliable signal for disco-native restaurants (see
    //     marketplace-restaurants.ts's comment on why it's excluded there for
    //     FM-backed rows: ~93% of FM-backed restaurants have is_live=false
    //     simply because it was never set, not because they're hidden).
    // A favorite with no cache match at all (is_disco_native/is_live both
    // NULL) is left exactly as it rendered before — that's a separate,
    // pre-existing "orphaned favorite" case, not this one.
    const rows = (await sql`
      WITH enriched AS (
        SELECT f.restaurant_reference, f.created_at,
               COALESCE(c.restaurant_reference, c2.restaurant_reference) AS canonical_reference,
               COALESCE(c.name, c2.name)             AS name,
               COALESCE(c.slug, c2.slug)             AS slug,
               COALESCE(c.image_url, c2.image_url)   AS image_url,
               COALESCE(c.cuisine, c2.cuisine)       AS cuisine,
               COALESCE(c.location, c2.location)     AS location,
               COALESCE(c.is_disco_native, c2.is_disco_native) AS is_disco_native,
               COALESCE(c.is_live, c2.is_live)       AS is_live
        FROM disco_customer_favorites f
        LEFT JOIN disco_restaurant_cache c  ON c.restaurant_reference = f.restaurant_reference
        LEFT JOIN disco_restaurant_cache c2 ON c2.slug = f.restaurant_reference
        WHERE f.customer_email = ${session.email}
      )
      SELECT e.*
      FROM enriched e
      LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = e.canonical_reference
      WHERE o.archived_at IS NULL
        AND NOT (COALESCE(e.is_disco_native, false) = true AND COALESCE(e.is_live, true) = false)
      ORDER BY e.created_at DESC
    `) as Array<{
      restaurant_reference: string
      canonical_reference: string | null
      name: string | null
      slug: string | null
      image_url: string | null
      cuisine: string | null
      location: string | null
    }>
    // Shape each row to the FavoriteRestaurant the client hook/pages expect.
    // location is "City, State" — split it so locationText()/the picker work.
    // Prefer the canonical UUID so the client keys + persists by UUID going forward.
    const favorites = rows.map(r => {
      const [city, state] = (r.location || '').split(',').map(s => s.trim())
      const reference = r.canonical_reference || r.restaurant_reference
      return {
        key: reference,
        reference,
        name: r.name || undefined,
        image: r.image_url || undefined,
        slug: r.slug || undefined,
        cuisine: r.cuisine || undefined,
        location: r.location || undefined,
        city: city || undefined,
        state: state || undefined,
      }
    })
    console.log(`[customer/favorites] GET — email=${session.email} count=${favorites.length}`)
    return NextResponse.json({ authenticated: true, email: session.email, favorites })
  } catch (err) {
    console.error('[customer/favorites] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ authenticated: true, email: session.email, favorites: [] })
  }
}

// POST /api/customer/favorites { restaurant_reference } — add a favorite.
export async function POST(req: NextRequest) {
  const session = await getCustomerSession(req)
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const ref = String(body?.restaurant_reference || '').trim()
    if (!ref) return NextResponse.json({ error: 'restaurant_reference required' }, { status: 400 })
    // No eager migration run — see withDiscoTables().
    await withDiscoTables(() => sql`
      INSERT INTO disco_customer_favorites (customer_email, restaurant_reference)
      VALUES (${session.email}, ${ref})
      ON CONFLICT (customer_email, restaurant_reference) DO NOTHING
    `)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[customer/favorites] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to add favorite' }, { status: 500 })
  }
}
