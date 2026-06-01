import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

async function auth() { return getRestaurantAuthHeader() }

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  // Optional ?restaurantRef=<ref> overrides the selected-location default so a
  // SYSTEM_ADMIN can fetch an EXPLICIT location's packages without switching
  // (powers the bulk-pricing fan-out). Falls back to the selected location.
  const restaurantRef = req.nextUrl.searchParams.get('restaurantRef') || await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'No restaurant reference' }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    const params = new URLSearchParams()
    if (sp.get('categoryReference')) params.set('categoryReference', sp.get('categoryReference')!)
    params.set('page', sp.get('page') || '0')
    params.set('size', sp.get('size') || '25')
    const res = await fetch(
      `${FM}/api/restaurants/${restaurantRef}/mealPackages?${params}`,
      { headers: h }
    )
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json({ error: 'Unable to fetch meal packages' }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'No restaurant reference' }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    const menuRef = sp.get('menu') || ''
    const body = await req.json()
    const res = await fetch(
      `${FM}/api/mealPackages?restaurantReference=${restaurantRef}&menu=${menuRef}`,
      {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to create meal package' }, { status: 500 }) }
}
