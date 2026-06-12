import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../lib/restaurant-auth-context'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

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
    const body = await req.json()
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
