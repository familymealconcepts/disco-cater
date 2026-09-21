import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  getRestaurantAuthHeader,
  getRestaurantHomeRef,
  getRestaurantRole,
  getFmSystemAdminPermittedRefs,
  RESTAURANT_COOKIE_OPTS,
  RESTAURANT_TOKEN_COOKIE,
  SELECTED_RESTAURANT_COOKIE,
} from '../../../../lib/restaurant-auth'
import { isDiscoNativeRestaurant } from '../../../../lib/order/native-checkout'
import { sql } from '../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { discoGroupRefs } from '../../../../lib/disco-restaurant-auth'
import { nativeSelectionAllowed } from '../../../../lib/native-selection-scope'

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

  // ── A DISCO-NATIVE TARGET IS DISCO'S TO AUTHORIZE, NOT FAMILYMEAL'S ────────
  // Below this point the caller holds an FM SYSTEM_ADMIN token — which is what
  // the master password issues, and how the Disco Cater team enters every
  // restaurant. Asking FM to select a Disco-native restaurant is asking the wrong
  // system: FM has never heard of it, refuses, and the cookie is never set. The
  // user then lands on whatever was previously selected. That is exactly what
  // happened when Peter clicked "Stacks & Cordials - Royal Oak (Copy)" and the
  // portal switched to Clawson.
  //
  // WHAT ACTUALLY GRANTS THE RIGHT, since this session has no email and no
  // disco_restaurant_location_access grants to check:
  //   FM has already decided which restaurants this token manages
  //   (getFmSystemAdminPermittedRefs -> FM's own system-admin/restaurants/list).
  //   A native reference is permitted if it shares a MULTI-UNIT LINK with at
  //   least one of those. So the right is inherited from FM's decision and
  //   bounded by the caller's own chain — it cannot reach a restaurant FM did not
  //   already authorize them for, and it needs no Disco identity.
  //
  // A native restaurant in NO chain, or in a chain containing nothing FM
  // authorized, is refused. That is deliberate: with no link to a permitted
  // restaurant there is nothing establishing that this admin owns it, and
  // guessing in the permissive direction here would hand someone another
  // operator's restaurant.
  if (await isDiscoNativeRestaurant(ref)) {
    const token = (await cookies()).get(RESTAURANT_TOKEN_COOKIE)?.value || ''
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const fmPermitted = await getFmSystemAdminPermittedRefs(token)
    if (!fmPermitted.size) return forbidden()
    // Shared with getRestaurantRef() via lib/native-selection-scope.ts — one
    // implementation, so the surface that SETS the selection and the surface that
    // READS it can never disagree about whether it was allowed.
    if (!(await nativeSelectionAllowed(ref, fmPermitted))) return forbidden()
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

// The server's answer to "which location is selected right now", so the client
// never has to infer it from its own storage. The cookie is the only store the
// scoping reads (resolveDiscoScopeRef, the orders route, sale-stats, customers,
// promo codes), so this is the authority.
//
// This exists because the portal used to answer that question from localStorage
// while every API answered it from the cookie. The two drift — iOS Safari evicts
// localStorage under ITP long before a 30-day cookie expires — and when they did,
// a SYSTEM_ADMIN saw one location's orders under a banner claiming all of them.
export async function GET() {
  const store = await cookies()
  const ref = store.get(SELECTED_RESTAURANT_COOKIE)?.value || null
  return NextResponse.json({ ref }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete(SELECTED_RESTAURANT_COOKIE)
  return resp
}
