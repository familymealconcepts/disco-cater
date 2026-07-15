import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { isDiscoNativeRestaurant } from '../../../../lib/order/native-checkout'
import { sql } from '../../../../lib/db'

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

  // Disco-native restaurant: no FM record — the FM proxy below 404s, so the
  // dashboard got an empty profile and its "your restaurant appears at …"
  // marketplace link fell back to the generic list (RM9). Build the profile from
  // Neon so the slug (and name) point at the restaurant's own marketplace page.
  if (ctx.authType === 'disco') {
    const scope = await resolveDiscoScopeRef(ctx)
    if (scope && await isDiscoNativeRestaurant(scope)) {
      const rows = (await sql`
        SELECT c.name, c.slug, c.phone, c.address, c.city, c.state, c.zipcode,
               a.email, a.first_name, a.last_name, a.business_name
        FROM disco_restaurant_cache c
        LEFT JOIN disco_restaurant_accounts a ON a.restaurant_reference = c.restaurant_reference
        WHERE c.restaurant_reference = ${scope} LIMIT 1
      `) as Array<Record<string, unknown>>
      const r = rows[0] ?? {}
      const slug = (r.slug as string) || ''
      const name = (r.name as string) || (r.business_name as string) || ''
      return NextResponse.json({
        reference: scope,
        name,
        businessName: (r.business_name as string) || name,
        businessNameWithoutSpaces: slug, // dashboard slug fallback + FM-shape parity
        slug,
        email: r.email ?? null,
        firstName: r.first_name ?? null,
        lastName: r.last_name ?? null,
        phone: r.phone ?? null,
        address: r.address ?? null,
        city: r.city ?? null,
        state: r.state ?? null,
        zipcode: r.zipcode ?? null,
        isDiscoNative: true,
      })
    }
  }

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
