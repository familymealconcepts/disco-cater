import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  params.set('page', sp.get('page') || '0')
  params.set('size', sp.get('size') || '25')
  if (sp.get('sort')) params.set('sort', sp.get('sort')!)
  if (sp.get('search')) params.set('search', sp.get('search')!)
  try {
    const res = await fetch(`${FM}/api/system-admin/users?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch users' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch users' }, { status: 500 })
  }
}

// Create a new team member. Mirrors FM's userService.createByRestaurant
// (admin-manager/authorized-users/update-authorized-users.component.ts:90 →
// _system/_services/user/user.service.ts:19).
//
// Body shape per FM source:
//   { firstName, lastName, email, role: 'SYSTEM_ADMIN' | 'ADMIN',
//     restaurantReference: string[] }
//
// `restaurantReference` is ALWAYS an array on the wire — single-location
// ADMIN gets [ref] not ref. FM normalizes server-side.
export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/system-admin/users`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to create user', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to create user' }, { status: 500 })
  }
}
