import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Initiates Stripe Connect onboarding for a restaurant. getToken reads the
// disco_token cookie (same as other auth routes); it also accepts an
// Authorization header — the become-a-partner flow keeps the JWT in localStorage
// (currentUser.authorization), not a cookie, so the client passes it as a header.
export async function POST(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let restaurantReference = ''
  try {
    const body = await req.json()
    restaurantReference = String(body?.restaurantReference || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  // New USER accounts have no restaurantReference on currentUser — it comes from
  // the create-restaurant step (stored as partner_restaurant_ref). If it's
  // missing, the restaurant wasn't created yet; say so plainly.
  if (!restaurantReference) {
    return NextResponse.json({ error: 'Restaurant not yet created' }, { status: 400 })
  }

  try {
    const res = await fetch(`${FM}/api/stripe/clients/${restaurantReference}/connect`, {
      method: 'POST',
      // Mirrors the working portal route: raw JWT (no "Bearer"), form-encoded
      // body with a callbackUri Stripe returns the merchant to after onboarding.
      headers: { Authorization: token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'callbackUri=https://www.discocater.com/become-a-partner?stripe=success',
    })
    const data = await res.json().catch(() => null)
    const stripeConnectUrl = data?.stripeConnectUrl || data?.url || data?.connectUrl || data?.link
    if (!res.ok || !stripeConnectUrl) {
      console.error(`[stripe-connect] FM ${res.status} for ${restaurantReference}:`, JSON.stringify(data)?.slice(0, 300))
      return NextResponse.json({ error: 'Could not initiate Stripe Connect. Please contact concierge@discocater.com.' }, { status: res.ok ? 502 : res.status })
    }
    return NextResponse.json({ stripeConnectUrl })
  } catch (err) {
    console.error('[stripe-connect] request failed:', err)
    return NextResponse.json({ error: 'Could not initiate Stripe Connect. Please contact concierge@discocater.com.' }, { status: 500 })
  }
}
