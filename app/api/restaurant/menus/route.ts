import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../lib/restaurant-auth-context'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM's SUPER_ADMIN menus endpoint returns MenuAdminResponseDto (`type`,
// `scheduleOption`) whereas the menus page reads `menuType` + top-level
// `startDate`/`endDate`. Alias those, pass the rest through. Disco branch only.
function normalizeAdminMenu(m: Record<string, unknown>): Record<string, unknown> {
  const sched = (m.scheduleOption ?? {}) as Record<string, unknown>
  return {
    ...m,
    menuType: m.menuType ?? m.type,
    startDate: m.startDate ?? sched.startDate,
    endDate: m.endDate ?? sched.endDate,
  }
}

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const h = await getFmHeaderForRestaurant(ctx)
  try {
    const sp = req.nextUrl.searchParams
    const params = new URLSearchParams()
    if (sp.get('filter')) params.set('filter', sp.get('filter')!)
    params.set('page', sp.get('page') || '0')
    params.set('size', sp.get('size') || '25')
    if (sp.get('sort')) params.set('sort', sp.get('sort')!)

    // Disco-only users → SUPER_ADMIN menus scoped by restaurantReference.
    let url = `${FM}/api/menu?${params}`
    if (usesServiceAccount(ctx)) {
      params.set('restaurantReference', ctx.restaurantReference)
      url = `${FM}/api/admin/menu?${params}`
    }

    const res = await fetch(url, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const data = await res.json()
    if (usesServiceAccount(ctx) && Array.isArray(data?.content)) {
      return NextResponse.json({ ...data, content: data.content.map(normalizeAdminMenu) })
    }
    return NextResponse.json(data)
  } catch { return NextResponse.json({ error: 'Unable to fetch' }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const h = await getFmHeaderForRestaurant(ctx)
  try {
    const body = await req.json()
    // Disco-only users → SUPER_ADMIN create-menu (restaurantReference query param).
    const url = usesServiceAccount(ctx)
      ? `${FM}/api/admin/menu?restaurantReference=${encodeURIComponent(ctx.restaurantReference)}`
      : `${FM}/api/menu`
    const res = await fetch(url, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to create' }, { status: 500 }) }
}
