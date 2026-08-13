import { NextRequest, NextResponse } from 'next/server'
import {
  getRestaurantAuthHeader,
  getRestaurantHomeRef,
  getRestaurantRole,
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
  // The permitted set mirrors resolveDiscoScopeRef's own role gate exactly:
  //   - SUPER_ADMIN (the Disco Cater team) is unrestricted — any ref is honored,
  //     matching the settled role model and FM's own SUPER_ADMIN parity (see
  //     getRestaurantRef's comment on the FM side of this same correction).
  //   - SYSTEM_ADMIN (a restaurant owner managing several locations) is scoped to
  //     their disco group (home + getDiscoGroupAccounts).
  //   - Plain ADMIN's only permitted ref is their own home restaurant
  //     (resolveDiscoScopeRef never honors the cookie for them regardless).
  // Any ref outside the permitted set is rejected outright — never silently
  // narrowed to home, since a cookie the reader will ignore is still a footgun
  // for future readers.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (ctx.role === 'SUPER_ADMIN') return setSelection(ref)
    const isSA = ctx.role === 'SYSTEM_ADMIN'
    const permitted = isSA
      ? await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)
      : new Set([ctx.restaurantReference].filter(Boolean))
    if (!permitted.has(ref)) return forbidden()
    return setSelection(ref)
  }

  // FM's own authorization model, not ours: api/system-admin/restaurants/* is
  // @PreAuthorize("hasAuthority('SYSTEM_ADMIN')") ONLY — it flatly denies
  // SUPER_ADMIN (confirmed against a real SUPER_ADMIN account: FM returns a 500
  // "Access is denied"). SUPER_ADMIN's real authority is its OWN unrestricted
  // controller (api/admin/restaurants/*, hasAuthority('SUPER_ADMIN'), no
  // per-restaurant ACL) — there is nothing to validate against FM for that role,
  // so we never call FM's SYSTEM_ADMIN-only switch endpoint for it.
  const role = await getRestaurantRole()
  if (role === 'SUPER_ADMIN') return setSelection(ref)

  // Any other FM role (plain ADMIN, RESTAURANT_ADMIN, RESTAURANT_USER) has no
  // "current restaurant" concept in FM at all — same api/system-admin/restaurants
  // controller would deny them too. Only their own home ref is ever valid.
  if (role !== 'SYSTEM_ADMIN') {
    const home = await getRestaurantHomeRef()
    if (ref !== home) return forbidden()
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
  // FM's own switch endpoint is the authority on what this SYSTEM_ADMIN may
  // select — if FM rejects it (not a managed location, etc.) the cookie must
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
