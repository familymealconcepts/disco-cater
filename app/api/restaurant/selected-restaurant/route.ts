import { NextRequest, NextResponse } from 'next/server'
import {
  getRestaurantAuthHeader,
  RESTAURANT_COOKIE_OPTS,
  SELECTED_RESTAURANT_COOKIE,
} from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { discoGroupRefs } from '../../../../lib/disco-restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function setSelection(ref: string) {
  const resp = NextResponse.json({ ok: true, ref })
  resp.cookies.set(SELECTED_RESTAURANT_COOKIE, ref, { ...RESTAURANT_COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
  return resp
}

function forbidden() {
  return NextResponse.json({ error: 'You do not have access to that restaurant' }, { status: 403 })
}

export async function PUT(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('restaurantReference') || ''
  if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

  // Disco-native sessions have no FM "current restaurant" concept — the selection
  // is expressed purely by the cookie (resolveDiscoScopeRef reads it). Never call
  // FM: a disco-native ref means nothing to FM, and native users must not touch it.
  //
  // The permitted set mirrors resolveDiscoScopeRef's own role gate exactly: a
  // plain ADMIN's only permitted ref is their own home restaurant (resolveDiscoScopeRef
  // never honors the cookie for them regardless), and a SYSTEM_ADMIN/SUPER_ADMIN's
  // permitted set is their disco group (home + getDiscoGroupAccounts). Any ref
  // outside that set is rejected outright — never silently narrowed to home,
  // since a cookie the reader will ignore is still a footgun for future readers.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const isSA = ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN'
    const permitted = isSA
      ? await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)
      : new Set([ctx.restaurantReference].filter(Boolean))
    if (!permitted.has(ref)) return forbidden()
    return setSelection(ref)
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  let fmRes: Response
  try {
    fmRes = await fetch(`${FM}/api/system-admin/restaurants/current?restaurantReference=${encodeURIComponent(ref)}`, {
      method: 'PUT',
      headers: h,
    })
  } catch {
    return NextResponse.json({ error: 'Unable to reach FamilyMeal to validate this selection' }, { status: 502 })
  }
  // FM's own switch endpoint is the authority on what this admin may select — if
  // FM rejects it (wrong role, not a managed location, etc.) the cookie must
  // never be set. Previously this was an empty `catch {}` that swallowed any
  // FM-side rejection and set the cookie unconditionally regardless of outcome.
  if (!fmRes.ok) {
    if (fmRes.status === 401 || fmRes.status === 403) return forbidden()
    return NextResponse.json({ error: 'FamilyMeal rejected this restaurant selection' }, { status: 502 })
  }
  return setSelection(ref)
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete(SELECTED_RESTAURANT_COOKIE)
  return resp
}
