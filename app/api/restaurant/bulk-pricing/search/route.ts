// Bulk-pricing fan-out search — find a menu item by name across ALL of a
// SYSTEM_ADMIN's locations. SYSTEM_ADMIN only.
//
// Per-location packages are read from the PUBLIC menu endpoints (menu →
// categories → mealPackages), which take the location ref in the URL and need
// no location switching — the flat /mealPackages endpoint requires a
// menuReference, so we traverse menus like the customer page does. Throttled to
// respect FM's rate sensitivity (the repo's own FM caller sleeps ~1s/req).

import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRole } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../../lib/disco-restaurant-auth'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface NativeItem { pkgRef: string; name: string; description: string | null; price: number | null; displayPrice: string | null; serves: string | null }

// Disco-native fan-out search: find menu items named `name` across every location
// in the SYSTEM_ADMIN's group, entirely from Neon (disco_menu_items). Zero FM.
async function nativeSearch(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  }
  const name = (req.nextUrl.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  const target = name.toLowerCase()

  // Location universe = the SA's group (+ their own location), same source the
  // location picker uses. disco_menu_items only exist for native restaurants, so
  // this naturally excludes any FM-backed refs.
  const refName = new Map<string, string>()
  if (ctx.restaurantReference) refName.set(ctx.restaurantReference, ctx.restaurantName || '')
  try {
    for (const g of await getDiscoGroupAccounts(ctx.businessName, ctx.email)) refName.set(g.restaurant_reference, g.restaurant_name || '')
  } catch { /* fall back to the home location only */ }
  const refs = [...refName.keys()]
  if (!refs.length) return NextResponse.json({ query: name, totalLocations: 0, matchedLocations: 0, matches: [] })

  await runDiscoMenuMigrations()
  const rows = (await sql`
    SELECT restaurant_reference::text AS rref, reference AS pkg_ref, name, description, price, display_price, serves
    FROM disco_menu_items
    WHERE restaurant_reference::text = ANY(${refs}) AND LOWER(name) = ${target}
    ORDER BY restaurant_reference, position, id
  `) as { rref: string; pkg_ref: string; name: string; description: string | null; price: string | number | null; display_price: string | null; serves: string | null }[]

  const byRef = new Map<string, NativeItem[]>()
  for (const r of rows) {
    if (!byRef.has(r.rref)) byRef.set(r.rref, [])
    byRef.get(r.rref)!.push({
      pkgRef: r.pkg_ref, name: String(r.name || ''),
      description: r.description != null && String(r.description).trim() !== '' ? String(r.description) : null,
      price: r.price != null ? Number(r.price) : null,
      displayPrice: r.display_price != null && String(r.display_price).trim() !== '' ? String(r.display_price) : null,
      serves: r.serves != null ? String(r.serves) : null,
    })
  }
  const matches = [...byRef.entries()].map(([rref, items]) => ({ restaurantRef: rref, restaurantName: refName.get(rref) || '', items }))
  return NextResponse.json({ query: name, totalLocations: refs.length, matchedLocations: matches.length, matches })
}

async function fmJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    // no-store so the post-apply refresh reflects freshly-updated prices.
    const res = await fetch(`${FM}${url}`, { headers: { Accept: 'application/json', ...(headers || {}) }, cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch { return null }
}

export async function GET(req: NextRequest) {
  // Disco-native SYSTEM_ADMINs resolve entirely from Neon — never touch FM.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return nativeSearch(ctx, req)

  const role = await getRestaurantRole()
  if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  }
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  const name = (req.nextUrl.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  const target = name.toLowerCase()

  const locations = await fmJson<{ reference: string; businessName: string }[]>('/api/system-admin/restaurants/list', h)
  if (!Array.isArray(locations)) return NextResponse.json({ error: 'Could not load locations' }, { status: 502 })

  const matches: { restaurantRef: string; restaurantName: string; items: { pkgRef: string; name: string; description: string | null; price: number | null; displayPrice: string | null; serves: string | null }[] }[] = []

  for (const loc of locations) {
    const seen = new Set<string>()
    const items: { pkgRef: string; name: string; description: string | null; price: number | null; displayPrice: string | null; serves: string | null }[] = []
    const menus = await fmJson<{ reference: string }[]>(`/public-api/menu?restaurantReference=${loc.reference}`)
    for (const menu of menus || []) {
      const cats = await fmJson<any[]>(`/public-api/restaurants/${loc.reference}/mealPackages?menuReference=${menu.reference}`)
      for (const c of cats || []) {
        const pkgs: any[] = Array.isArray(c?.mealPackages) ? c.mealPackages : []
        for (const p of pkgs) {
          if (!p?.reference || seen.has(p.reference)) continue
          if (String(p.name || '').trim().toLowerCase() === target) {
            seen.add(p.reference)
            items.push({
              pkgRef: p.reference,
              name: String(p.name || ''),
              description: p.description != null && String(p.description).trim() !== '' ? String(p.description) : null,
              price: typeof p.price === 'number' ? p.price : (p.price != null ? Number(p.price) : null),
              displayPrice: p.displayPrice != null && String(p.displayPrice).trim() !== '' ? String(p.displayPrice) : null,
              serves: p.serves != null ? String(p.serves) : null,
            })
          }
        }
      }
      await sleep(120) // gentle on FM between menu fetches
    }
    if (items.length) matches.push({ restaurantRef: loc.reference, restaurantName: loc.businessName, items })
  }

  return NextResponse.json({
    query: name,
    totalLocations: locations.length,
    matchedLocations: matches.length,
    matches,
  })
}
