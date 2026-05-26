import { NextRequest, NextResponse } from 'next/server'
import {
  getRestaurantAuthHeader,
  RESTAURANT_COOKIE_OPTS,
  SELECTED_RESTAURANT_COOKIE,
} from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const ref = req.nextUrl.searchParams.get('restaurantReference') || ''
  if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })
  try {
    await fetch(`${FM}/api/system-admin/restaurants/current?restaurantReference=${ref}`, {
      method: 'PUT',
      headers: h,
    })
  } catch {}
  const resp = NextResponse.json({ ok: true, ref })
  resp.cookies.set(SELECTED_RESTAURANT_COOKIE, ref, {
    ...RESTAURANT_COOKIE_OPTS,
    maxAge: 60 * 60 * 24 * 30,
  })
  return resp
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete(SELECTED_RESTAURANT_COOKIE)
  return resp
}
