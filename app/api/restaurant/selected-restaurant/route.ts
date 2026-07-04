import { NextRequest, NextResponse } from 'next/server'
import {
  getRestaurantAuthHeader,
  RESTAURANT_COOKIE_OPTS,
  SELECTED_RESTAURANT_COOKIE,
} from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function setSelection(ref: string) {
  const resp = NextResponse.json({ ok: true, ref })
  resp.cookies.set(SELECTED_RESTAURANT_COOKIE, ref, { ...RESTAURANT_COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
  return resp
}

export async function PUT(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('restaurantReference') || ''
  if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

  // Disco-native sessions have no FM "current restaurant" concept — the selection
  // is expressed purely by the cookie (resolveDiscoScopeRef reads it). Never call
  // FM: a disco-native ref means nothing to FM, and native users must not touch it.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return setSelection(ref)

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    await fetch(`${FM}/api/system-admin/restaurants/current?restaurantReference=${ref}`, {
      method: 'PUT',
      headers: h,
    })
  } catch {}
  return setSelection(ref)
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete(SELECTED_RESTAURANT_COOKIE)
  return resp
}
