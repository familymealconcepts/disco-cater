import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { discoGroupRefs, getLocationAccessRefs, grantLocationAccess } from '../../../../../../lib/disco-restaurant-auth'
import { sql, runMigrations, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { cloneDiscoRestaurantMenus } from '../../../../../../lib/locations/clone-restaurant'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: duplicate the location (profile + full menu tree) into a new,
  // not-live restaurant in the SA's group. Zero FM.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const refs = await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)
    if (!refs.has(ref)) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    await runMigrations(); await runDiscoOrderMigrations()
    const rows = (await sql`SELECT * FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as Record<string, unknown>[]
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const s = rows[0]
    const newRef = randomUUID()
    const newSlug = `${(s.slug as string) || 'location'}-copy-${newRef.slice(0, 8)}`
    await sql`
      INSERT INTO disco_restaurant_cache (
        restaurant_reference, name, slug, cuisine, description, image_url, lat, lng, location,
        address, address_line2, city, state, zipcode, phone, timezone, icon_url, is_disco_native, is_live
      ) VALUES (
        ${newRef}, ${((s.name as string) || 'Location') + ' (Copy)'}, ${newSlug}, ${s.cuisine}, ${s.description}, ${s.image_url}, ${s.lat}, ${s.lng}, ${s.location},
        ${s.address}, ${s.address_line2}, ${s.city}, ${s.state}, ${s.zipcode}, ${s.phone}, ${s.timezone}, ${s.icon_url}, true, false
      )`
    // Make the clone visible in the SA's group without dropping existing locations:
    // if they're already on explicit access, just add the clone; otherwise backfill
    // their current group into explicit access (else granting one ref would hide the
    // rest, since explicit access wins over business-name grouping).
    const existing = await getLocationAccessRefs(ctx.email)
    const toGrant = existing.length ? [newRef] : [...refs, newRef]
    for (const r of toGrant) await grantLocationAccess(ctx.email, r, ctx.email).catch(() => {})
    await cloneDiscoRestaurantMenus(ref, newRef)
    return NextResponse.json({ ok: true, reference: newRef })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}/clone`, { method: 'POST', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to clone' }, { status: 500 }) }
}
