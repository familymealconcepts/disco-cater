import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../lib/restaurant-auth-context'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Deep-merge `patch` onto `base`: nested objects merge recursively; arrays and
// primitives replace; `undefined` patch values are ignored (keep base). Same
// pattern as the admin edit route — used so a partial profile save keeps every
// field the caller didn't touch.
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const baseObj = (base && typeof base === 'object' && !Array.isArray(base)) ? (base as Record<string, unknown>) : {}
  const out: Record<string, unknown> = { ...baseObj }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    out[k] = deepMerge(baseObj[k], v)
  }
  return out
}

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const authHeaders = await getFmHeaderForRestaurant(ctx)

  // Disco-only users hit the SUPER_ADMIN by-reference endpoint; FM users keep the
  // session-scoped /api/restaurants call.
  const url = usesServiceAccount(ctx)
    ? `${FM}/api/admin/restaurants/${ctx.restaurantReference}`
    : `${FM}/api/restaurants`

  try {
    const res = await fetch(url, { headers: authHeaders })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch profile' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('restaurant/profile GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // FM's SUPER_ADMIN restaurant-update endpoint is multipart-only and takes a
  // different shape than the JSON the portal sends here, so Disco-only profile
  // edits aren't wired yet. FM users (incl. Disco users who also have an FM
  // token) keep the existing JSON PUT.
  if (usesServiceAccount(ctx)) {
    return NextResponse.json(
      { error: 'Profile editing isn’t available for Disco accounts yet. Email concierge@discocater.com to update your details.' },
      { status: 501 }
    )
  }

  const authHeaders = await getFmHeaderForRestaurant(ctx)
  try {
    const incoming = await req.json()

    // GUARD (see the Kealoha / setOrderingFalseIfValidateDoesNotPass investigation):
    // FM's updateRestaurant re-runs its ordering validation on every save and
    // auto-disables online ordering if the SAVED restaurant is missing a complete
    // address (incl. lat/lng), a contact phone, or a connected Stripe account —
    // it ignores whatever onlineOrderingAllowed value we send. A partial profile
    // PUT (e.g. the DoorDash/pickup-instructions save) that omits or blanks an
    // address subfield would therefore silently turn ordering off. So GET the
    // current FM restaurant and deep-merge our changes onto it, exactly like the
    // admin safe-edit route — the outgoing object always carries the full existing
    // address + contact, so a save can't fail FM's validation by dropping a field.
    let body = incoming
    try {
      const cur = await fetch(`${FM}/api/restaurants`, { headers: authHeaders })
      if (cur.ok) {
        const current = await cur.json().catch(() => null)
        if (current && typeof current === 'object') body = deepMerge(current, incoming)
      }
    } catch { /* fall back to the raw incoming body if the pre-read fails */ }

    const res = await fetch(`${FM}/api/restaurants`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to update profile', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (err) {
    console.error('restaurant/profile PUT error:', err)
    return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
  }
}
