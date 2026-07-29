import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../lib/restaurant-auth-context'
import { decodeJwtPayload } from '../../../../lib/jwt'

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

// Count a menu's items via FM's public per-menu catalog (categories → nested
// mealPackages). Best-effort — a fetch/shape failure yields 0, never throws.
async function menuItemCount(restaurantRef: string, menuRef: string, headers: Record<string, string>): Promise<number> {
  if (!restaurantRef || !menuRef) return 0
  try {
    const r = await fetch(`${FM}/public-api/restaurants/${restaurantRef}/mealPackages?menuReference=${menuRef}`, { headers })
    if (!r.ok) return 0
    const d = await r.json().catch(() => null)
    const cats = Array.isArray(d) ? d : (Array.isArray(d?.content) ? d.content : [])
    return cats.reduce((a: number, c: { mealPackages?: unknown[] }) => a + (Array.isArray(c?.mealPackages) ? c.mealPackages.length : 0), 0)
  } catch { return 0 }
}

// Enrich each menu row for the Manage Menus table's columns: Items (count),
// Lead Time (scheduleOption.prepTime hours), Service Types (settings.menuAvailability,
// FM default = both when unset). itemCount is fetched per menu in parallel.
async function enrichMenus(
  content: Record<string, unknown>[],
  ctx: { restaurantReference: string },
  headers: Record<string, string>,
  isServiceAccount: boolean,
): Promise<Record<string, unknown>[]> {
  return Promise.all(content.map(async (raw) => {
    const m = isServiceAccount ? normalizeAdminMenu(raw) : raw
    const sched = (m.scheduleOption ?? {}) as Record<string, unknown>
    const settings = (m.settings ?? {}) as Record<string, unknown>
    const avail = Array.isArray(settings.menuAvailability)
      ? (settings.menuAvailability as unknown[]).map(v => String(v).toUpperCase()).filter(v => v === 'PICKUP' || v === 'DELIVERY')
      : []
    const serviceTypes = avail.length ? avail : ['PICKUP', 'DELIVERY'] // FM default when unset = both
    const prep = Number(sched.prepTime)
    const leadTimeHours = Number.isFinite(prep) && prep > 0 ? prep : null
    const restaurantRef = String((m.restaurant as Record<string, unknown> | undefined)?.reference || ctx.restaurantReference || '')
    const itemCount = await menuItemCount(restaurantRef, String(m.reference || ''), headers)
    return { ...m, itemCount, leadTimeHours, serviceTypes }
  }))
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
    if (Array.isArray(data?.content)) {
      // ctx.restaurantReference is always '' for ordinary FM-authenticated sessions
      // (only Disco-native sessions carry it) — the regular (non-admin) /api/menu
      // response also has no nested `restaurant` per menu (only the SUPER_ADMIN
      // shape does), so without this every normal restaurant-owner login silently
      // got itemCount 0 for every menu. The FM JWT itself carries the restaurant
      // reference as its `restaurant` claim — decode that as the real fallback.
      const restaurantReference = ctx.restaurantReference
        || (ctx.fmToken ? String(decodeJwtPayload(ctx.fmToken)?.restaurant || '') : '')
      const content = await enrichMenus(data.content, { restaurantReference }, h, usesServiceAccount(ctx))
      return NextResponse.json({ ...data, content })
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
    const text = await res.text()
    if (!res.ok) {
      console.error('[restaurant/menus POST] FM error', res.status, text.slice(0, 800))
      return NextResponse.json({ error: 'Failed to create menu', fmStatus: res.status, raw: text.slice(0, 1000) }, { status: res.status })
    }
    let data: unknown = { ok: true }
    try { if (text) data = JSON.parse(text) } catch { data = { ok: true, raw: text.slice(0, 500) } }
    return NextResponse.json(data)
  } catch (e) {
    console.error('[restaurant/menus POST] proxy error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create' }, { status: 500 })
  }
}
