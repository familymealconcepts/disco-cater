import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../../lib/restaurant-write-scope'
import { sql, runMigrations } from '../../../../../lib/db'
import { restaurantActorEmail, overridesSnapshot, pick, logSettingsChange } from '../../../../../lib/settings-audit'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Money movement: this unlinks a restaurant's Stripe payout account. The
// target is the client-claimed restaurant_reference (query param — this route
// has no body), verified against the caller's permitted set — never the
// session's current selection (see disco-profile's PUT for the full
// stale-intent rationale). Fails closed on any mismatch.
export async function DELETE(req: NextRequest) {
  const check = await requireWritableRestaurantRef(req.nextUrl.searchParams.get('restaurant_reference'))
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref

  // Disco-native: unlink the connected Stripe account (payouts stop; the account
  // itself stays on Stripe but is no longer referenced). Reconnecting starts a
  // fresh Connect onboarding. Existing orders' refunds still work — they go through
  // the original PaymentIntent, not the current stripe_account_id.
  //
  // Restaurant archiving (lib/disco-restaurant-archive.ts) MUST NEVER call this
  // route or otherwise touch stripe_account_id — an archived restaurant's
  // Stripe connection and any money in flight (pending payouts, in-progress
  // PaymentIntents) must be left completely alone. Archiving hides the
  // storefront and access; it is not a payments action.
  const ctx = await getRestaurantAuthContext()

  // Attribution. Money movement, and the `before` value is the whole point: once
  // stripe_account_id is NULL the id that WAS connected is gone from the row, so
  // the audit row is the only remaining record of which account was unlinked.
  // Logged before the write on both branches for exactly that reason.
  const auditDisconnect = async (extra?: Record<string, unknown>) => {
    try {
      await logSettingsChange({
        action: 'stripe_disconnect',
        restaurantReference: ref,
        actorEmail: ctx ? restaurantActorEmail(ctx) : null,
        authType: ctx?.authType ?? 'fm',
        before: pick(await overridesSnapshot(ref), ['stripe_account_id']),
        after: { stripe_account_id: null },
        extra,
      })
    } catch (e) {
      console.error('[stripe/disconnect] audit row failed:', e instanceof Error ? e.message : e)
    }
  }

  if (ctx?.authType === 'disco') {
    await runMigrations()
    await auditDisconnect()
    await sql`UPDATE disco_restaurant_overrides SET stripe_account_id = NULL, updated_at = NOW() WHERE restaurant_reference = ${ref}`
    return NextResponse.json({ ok: true })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  // FM's stripe/disconnect/{ref} endpoint DOES take an explicit ref in the URL —
  // use the verified ref directly.
  try {
    const res = await fetch(`${FM}/api/stripe/disconnect/${encodeURIComponent(ref)}`, { headers: h })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to disconnect Stripe', raw: err }, { status: res.status })
    }
    const text = await res.text()
    // FM has accepted; record it. `before` is what Disco's own row held — FM owns
    // the authoritative link on this path, so the two can legitimately differ.
    await auditDisconnect({ fmProxied: true })
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to disconnect Stripe' }, { status: 500 })
  }
}
