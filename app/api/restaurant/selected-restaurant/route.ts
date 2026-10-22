import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  getRestaurantAuthHeader,
  getRestaurantHomeRef,
  getRestaurantRole,
  getFmSessionPermittedRefs,
  RESTAURANT_COOKIE_OPTS,
  RESTAURANT_TOKEN_COOKIE,
  SELECTED_RESTAURANT_COOKIE,
} from '../../../../lib/restaurant-auth'
import { isDiscoNativeRestaurant } from '../../../../lib/order/native-checkout'
import { sql } from '../../../../lib/db'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
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

  // ── DISCO'S LIST DECIDES, FOR EVERY TARGET (22 Oct 2026) ──────────────────
  // A FamilyMeal-password System Admin may select exactly the locations on
  // their Disco list (getFmSessionPermittedRefs), native or FM-backed. The old
  // rule — FamilyMeal's own list, plus any native location sharing a
  // multi-unit link page with it — is gone; it reached other businesses.
  const token = (await cookies()).get(RESTAURANT_TOKEN_COOKIE)?.value || ''
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const permitted = await getFmSessionPermittedRefs(token)
  if (!permitted.has(ref)) return forbidden()
  if (await isDiscoNativeRestaurant(ref)) return setSelection(ref)

  // FM-backed: also move FamilyMeal's own "current restaurant" for this
  // session (the selection switch, unchanged), so FM-proxied screens follow.
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
// GET → { ref, name } — the selection the SERVER will actually scope by.
//
// The sidebar label used to trust the cookie's raw value plus a name cached in
// localStorage. Neither is what an API scopes by for a Disco session:
// resolveDiscoScopeRef falls back to the home location when the cookie names a
// location no longer on the person's list (removed, or left over from another
// login in the same browser). The label then named one location while every
// save landed on another. So this answers with the EFFECTIVE selection — a
// cookie the server would not honour is cleared here and reported as none —
// and with that location's own name from disco_restaurant_cache, so the label
// and the writes cannot disagree.
export async function GET() {
  const store = await cookies()
  const raw = (store.get(SELECTED_RESTAURANT_COOKIE)?.value || '').trim() || null
  const headers = { 'Cache-Control': 'no-store' }
  if (!raw) return NextResponse.json({ ref: null, name: null }, { headers })

  const ctx = await getRestaurantAuthContext().catch(() => null)
  let ref: string | null = raw
  if (ctx?.authType === 'disco') {
    const effective = await resolveDiscoScopeRef(ctx).catch(() => '')
    if (effective !== raw) ref = null
  }
  if (!ref) {
    const resp = NextResponse.json({ ref: null, name: null, cleared: true }, { headers })
    resp.cookies.delete(SELECTED_RESTAURANT_COOKIE)
    return resp
  }
  const rows = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`.catch(() => [])) as Array<{ name: string | null }>
  return NextResponse.json({ ref, name: rows[0]?.name || null }, { headers })
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.delete(SELECTED_RESTAURANT_COOKIE)
  return resp
}
