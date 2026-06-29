import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../lib/customer-auth'
import { runDiscoOrderMigrations, sql } from '../../../../lib/db'

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
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT f.restaurant_reference,
             c.name, c.slug, c.image_url, c.cuisine, c.location
      FROM disco_customer_favorites f
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = f.restaurant_reference
      WHERE f.customer_email = ${session.email}
      ORDER BY f.created_at DESC
    `) as Array<{
      restaurant_reference: string
      name: string | null
      slug: string | null
      image_url: string | null
      cuisine: string | null
      location: string | null
    }>
    // Shape each row to the FavoriteRestaurant the client hook/pages expect.
    // location is "City, State" — split it so locationText()/the picker work.
    const favorites = rows.map(r => {
      const [city, state] = (r.location || '').split(',').map(s => s.trim())
      return {
        key: r.restaurant_reference,
        reference: r.restaurant_reference,
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
    await runDiscoOrderMigrations()
    await sql`
      INSERT INTO disco_customer_favorites (customer_email, restaurant_reference)
      VALUES (${session.email}, ${ref})
      ON CONFLICT (customer_email, restaurant_reference) DO NOTHING
    `
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[customer/favorites] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to add favorite' }, { status: 500 })
  }
}
