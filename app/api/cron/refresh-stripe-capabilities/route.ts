import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { alertOnce } from '../../../../lib/ops-alert'
import { refreshStripeCapabilities } from '../../../../lib/stripe-capability-refresh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Refreshes the stored Stripe capability snapshot every hour, at :40.
//
// HOURLY, because the cost of being wrong is asymmetric and time-bound. A
// restriction that lands mid-morning must not leave a restaurant selling into a
// payment that cannot complete until the next day; an hour is the longest window
// worth tolerating for a storefront that is quietly broken. It is also cheap:
// 190 attached accounts at ~150ms each, eight at a time, is roughly 4 seconds of
// work, and Stripe account reads are not rate-limited at anything near this.
//
// Faster would buy little — Stripe restrictions are not minute-to-minute events,
// and the admin screen keeps an on-demand recheck for the case where somebody is
// actively working a specific restaurant and wants the answer now.
//
// :40 keeps it clear of the top of the hour, where seven other crons fire.
//
// REQUIRED ENV: CRON_SECRET, and STRIPE_READONLY_KEY (or STRIPE_SECRET_KEY).
function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const key = process.env.STRIPE_READONLY_KEY || process.env.STRIPE_SECRET_KEY
  if (!key) {
    await alertOnce('stripe-capability-refresh:no-key', 'refresh-stripe-capabilities: no Stripe key configured — capability snapshot is going stale', {})
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }
  try {
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' as never })
    const s = await refreshStripeCapabilities(stripe)
    console.log(`[cron/refresh-stripe-capabilities] checked=${s.checked} connected=${s.connected} atRisk=${s.atRisk} restricted=${s.restricted} unknown=${s.unknown} changed=${s.changed}`)
    // Only a CHANGE is worth an alert, and only once per restaurant per transition —
    // a standing restriction is already visible on the admin screen and does not
    // need to be re-announced every hour. See lib/ops-alert.ts's rule.
    for (const f of s.flips) {
      if (f.to === 'restricted') {
        await alertOnce(
          `stripe-restricted:${f.restaurantReference}:${f.to}`,
          'Stripe has RESTRICTED a restaurant’s account — it can no longer take orders and is now hidden from its locations page',
          { restaurantReference: f.restaurantReference, from: f.from, to: f.to },
        )
      }
    }
    return NextResponse.json({ ok: true, ...s })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('[cron/refresh-stripe-capabilities] failed:', error)
    await alertOnce('stripe-capability-refresh:failed', 'refresh-stripe-capabilities FAILED — Stripe capability snapshot is going stale', { error })
    return NextResponse.json({ error: 'refresh failed' }, { status: 500 })
  }
}
