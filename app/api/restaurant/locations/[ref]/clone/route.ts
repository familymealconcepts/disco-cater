import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getLocationAccessRefs, grantLocationAccess } from '../../../../../../lib/disco-restaurant-auth'
import { resolveDiscoGroupScope, discoRefAllowed } from '../../../../../../lib/restaurant-write-scope'
import { getCallerScopeRefs } from '../../../../../../lib/order/order-scope'
import { sql, runMigrations, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { cloneDiscoRestaurantMenus, cloneDiscoRestaurantOverrides } from '../../../../../../lib/locations/clone-restaurant'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()

  // WHICH SYSTEM OWNS THE DUPLICATE IS DECIDED BY THE SOURCE RESTAURANT, NOT BY
  // HOW THE CALLER HAPPENS TO BE LOGGED IN.
  //
  // This used to branch on `ctx?.authType === 'disco'`, so a SYSTEM_ADMIN holding
  // an fm_restaurant_token fell through to the FM path and POSTed to FM's clone
  // endpoint even when duplicating a Disco-native restaurant — creating a
  // FamilyMeal record for a native one, which the architecture forbids outright.
  // Three such records exist ([COPY] Stacks & Cordials - Royal Oak x2, [COPY] Tap
  // 42 - Aventura). Same defect shape as the super-admin 404 fixed in 443e91c:
  // deciding from the caller's cookie rather than from the thing that matters.
  await runMigrations(); await runDiscoOrderMigrations()
  const rows = (await sql`SELECT * FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as Record<string, unknown>[]
  // Never guess. Falling back to the FM path for an unresolvable source is exactly
  // how an FM record gets created for a native restaurant, so an unknown source is
  // an error, not a default.
  if (!rows.length) {
    return NextResponse.json({
      error: 'Could not find this location, so it was not duplicated. Email concierge@discocater.com and we’ll look into it.',
    }, { status: 404 })
  }
  const sourceIsNative = rows[0].is_disco_native === true

  // Disco-native: duplicate the location (profile + full menu tree) into a new,
  // not-live restaurant in the SA's group. Zero FM.
  if (sourceIsNative) {
    if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    // A disco session keeps its existing group check unchanged. An FM session is
    // now reachable here (it never was before) and is scoped with the same
    // both-auth-types resolver the order routes use, because a native restaurant
    // has no FM record for FM to authorize against.
    const scope = ctx.authType === 'disco' ? await resolveDiscoGroupScope(ctx) : null
    const allowed = scope
      ? discoRefAllowed(scope, ref)
      : (await getCallerScopeRefs(ctx)).has(ref.trim().toLowerCase())
    if (!allowed) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
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
    // Only a disco session has a real email to grant against — an FM session's
    // ctx.email is always '' (see RestaurantAuthContext), and location access is a
    // disco-native concept, so there is nothing to grant for an FM caller.
    if (scope && ctx.email) {
      const existing = await getLocationAccessRefs(ctx.email)
      const toGrant = existing.length || scope.unrestricted ? [newRef] : [...scope.refs, newRef]
      for (const r of toGrant) await grantLocationAccess(ctx.email, r, ctx.email).catch(() => {})
    }
    await cloneDiscoRestaurantMenus(ref, newRef)
    // The settings row, WITHOUT the Stripe account — see cloneDiscoRestaurantOverrides.
    // Without this the duplicate has no tax config and checkout refuses every order,
    // which is how both existing native copies ended up unable to transact.
    await cloneDiscoRestaurantOverrides(ref, newRef)
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
