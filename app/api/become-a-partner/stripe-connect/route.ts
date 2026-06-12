import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Starts Stripe Connect onboarding for a restaurant during become-a-partner.
// The brand-new ADMIN account's password isn't usable yet (FM emails a temp
// password), so we authenticate with the SUPER_ADMIN service account — NOT the
// restaurant's own token. Returns the hosted Stripe onboarding URL.
export async function POST(req: NextRequest) {
  let restaurantReference = ''
  try {
    const body = await req.json()
    restaurantReference = String(body?.restaurantReference || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (!restaurantReference) {
    return NextResponse.json({ error: 'Restaurant not yet created' }, { status: 400 })
  }

  const call = (header: Record<string, string>) =>
    fetch(`${FM}/api/stripe/clients/${restaurantReference}/connect`, {
      method: 'POST',
      headers: { ...header, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'callbackUri=https://www.discocater.com/become-a-partner?stripe=success',
    })

  try {
    let res = await call(await getFmServiceAuthHeader())
    // One retry on an expired service token.
    if (res.status === 401) res = await call(await getFmServiceAuthHeader(true))

    const data = await res.json().catch(() => null)
    const stripeConnectUrl = data?.stripeConnectUrl || data?.url || data?.connectUrl || data?.link
    if (!res.ok || !stripeConnectUrl) {
      console.error(`[stripe-connect] FM ${res.status} for ${restaurantReference}:`, JSON.stringify(data)?.slice(0, 300))
      return NextResponse.json(
        { error: 'Could not initiate Stripe Connect. You can connect later from your dashboard.' },
        { status: res.ok ? 502 : res.status }
      )
    }
    return NextResponse.json({ stripeConnectUrl })
  } catch (err) {
    console.error('[stripe-connect] request failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Could not initiate Stripe Connect. You can connect later from your dashboard.' },
      { status: 500 }
    )
  }
}
