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

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fmJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    // no-store so the post-apply refresh reflects freshly-updated prices.
    const res = await fetch(`${FM}${url}`, { headers: { Accept: 'application/json', ...(headers || {}) }, cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch { return null }
}

export async function GET(req: NextRequest) {
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
