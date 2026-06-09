import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { sql, runMigrations } from '../../../../lib/db'

// Read-only restaurant export for CRM sync. API-key protected. Reads Neon only
// (cache joined to overrides) — no FM call. Returns the visible + stripe-connected
// set that the public fullmap shows.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await runMigrations()

    const rows = (await sql`
      SELECT c.restaurant_reference, c.name, c.slug, c.cuisine, c.location, c.lat, c.lng,
             o.is_premium, o.stripe_connected
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      WHERE o.visible = true AND o.stripe_connected = true
    `) as {
      restaurant_reference: string; name: string; slug: string | null; cuisine: string | null
      location: string | null; lat: string | null; lng: string | null
      is_premium: boolean | null; stripe_connected: boolean | null
    }[]

    const restaurants = rows.map((r) => ({
      reference: r.restaurant_reference,
      name: r.name,
      slug: r.slug || '',
      cuisine: r.cuisine || 'Other',
      location: r.location || '',
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      isPremium: r.is_premium ?? false,
      stripeConnected: r.stripe_connected ?? false,
    }))

    return NextResponse.json(restaurants, { headers: { 'X-Total-Count': String(restaurants.length) } })
  } catch (e) {
    console.error('[export/restaurants] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export restaurants' }, { status: 500 })
  }
}
