import { NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function DELETE() {
  // Disco-native: unlink the connected Stripe account (payouts stop; the account
  // itself stays on Stripe but is no longer referenced). Reconnecting starts a
  // fresh Connect onboarding. Existing orders' refunds still work — they go through
  // the original PaymentIntent, not the current stripe_account_id.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const ref = await resolveDiscoScopeRef(ctx)
    if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
    await runMigrations()
    await sql`UPDATE disco_restaurant_accounts SET stripe_account_id = NULL WHERE restaurant_reference = ${ref}`
    return NextResponse.json({ ok: true })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const res = await fetch(`${FM}/api/stripe/disconnect/${restaurantRef}`, { headers: h })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to disconnect Stripe', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to disconnect Stripe' }, { status: 500 })
  }
}
