// Bulk-pricing fan-out search — find a menu item by name across ALL of a
// SYSTEM_ADMIN's locations. SYSTEM_ADMIN / SUPER_ADMIN only.
//
// ── ONE SEARCH, PER-LOCATION SOURCE ─────────────────────────────────────────
// This used to be two whole branches picked by SESSION TYPE: a disco session
// searched Neon, an FM session searched FamilyMeal. A converting chain is mixed
// for as long as conversion takes (17 brands / 134 locations on 2026-09-16), so
// both branches were wrong for it — the FM one returned the FROZEN FM menu for
// already-converted locations, the Disco one could not see unconverted siblings
// at all. Now the universe is resolved once (lib/location-universe.ts) and each
// location is read from the store that actually owns its menu: native → Neon,
// FM-backed → FamilyMeal.
//
// Per-location FM packages are read from the PUBLIC menu endpoints (menu →
// categories → mealPackages), which take the location ref in the URL and need no
// location switching — the flat /mealPackages endpoint requires a menuReference,
// so we traverse menus like the customer page does. Throttled to respect FM's
// rate sensitivity.

import { NextRequest, NextResponse } from 'next/server'
import { resolveLocationUniverse } from '../../../../../lib/location-universe'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Item { pkgRef: string; name: string; description: string | null; price: number | null; displayPrice: string | null; serves: string | null }
interface Match { restaurantRef: string; restaurantName: string; source: 'native' | 'fm'; items: Item[] }

async function fmJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    // no-store so the post-apply refresh reflects freshly-updated prices.
    const res = await fetch(`${FM}${url}`, { headers: { Accept: 'application/json', ...(headers || {}) }, cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch { return null }
}

export async function GET(req: NextRequest) {
  const scope = await resolveLocationUniverse()
  if (!scope) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (scope.role !== 'SYSTEM_ADMIN' && !scope.isSuperAdmin) {
    return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  }

  const name = (req.nextUrl.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  const target = name.toLowerCase()

  const nativeRefs = scope.locations.filter(l => l.native).map(l => l.ref)
  const fmLocs = scope.locations.filter(l => !l.native)
  const nameOf = new Map(scope.locations.map(l => [l.ref, l.name]))
  const matches: Match[] = []

  // ── Native locations: one Neon query for all of them ──────────────────────
  if (nativeRefs.length) {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      SELECT restaurant_reference::text AS rref, reference AS pkg_ref, name, description, price, display_price, serves
      FROM disco_menu_items
      WHERE restaurant_reference::text = ANY(${nativeRefs}) AND LOWER(name) = ${target}
      ORDER BY restaurant_reference, position, id
    `) as { rref: string; pkg_ref: string; name: string; description: string | null; price: string | number | null; display_price: string | null; serves: string | null }[]
    const byRef = new Map<string, Item[]>()
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
    for (const [rref, items] of byRef) matches.push({ restaurantRef: rref, restaurantName: nameOf.get(rref) || '', source: 'native', items })
  }

  // ── FM-backed locations: traverse FamilyMeal's public menus ───────────────
  const failed: Array<{ ref: string; name: string; reason: string }> = []
  for (const loc of fmLocs) {
    const seen = new Set<string>()
    const items: Item[] = []
    const menus = await fmJson<{ reference: string }[]>(`/public-api/menu?restaurantReference=${loc.ref}`)
    if (menus === null) {
      // Say so rather than reporting "no match" for a location we never read.
      failed.push({ ref: loc.ref, name: loc.name, reason: 'FamilyMeal did not return this location’s menus' })
      continue
    }
    for (const menu of menus) {
      const cats = await fmJson<any[]>(`/public-api/restaurants/${loc.ref}/mealPackages?menuReference=${menu.reference}`)
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
    if (items.length) matches.push({ restaurantRef: loc.ref, restaurantName: loc.name, source: 'fm', items })
  }

  matches.sort((a, b) => a.restaurantName.localeCompare(b.restaurantName))

  // skipped is reported, never silently dropped: an operator must not be shown a
  // short list that looks like a complete one.
  const skipped = [...scope.unreadable, ...failed]
  return NextResponse.json({
    query: name,
    totalLocations: scope.locations.length + scope.unreadable.length,
    nativeLocations: nativeRefs.length,
    fmLocations: fmLocs.length,
    matchedLocations: matches.length,
    matches,
    skipped,
    ...(skipped.length ? { warning: `${skipped.length} location(s) could not be searched — see skipped.` } : {}),
  })
}
