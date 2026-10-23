import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { alertOnce, resolveAlert, noteJobFailure, noteJobSuccess } from '../../../../lib/ops-alert'
import { SUGGESTIONS } from '../../../../lib/ops-alert-format'
import { restaurantName } from '../../../../lib/ops-alert-facts'
import { refreshStripeCapabilities } from '../../../../lib/stripe-capability-refresh'
import { withCronRun } from '../../../../lib/cron-runs'

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

async function runGet(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const key = process.env.STRIPE_READONLY_KEY || process.env.STRIPE_SECRET_KEY
  if (!key) {
    await alertOnce('config:stripe-capability-key', {
      severity: 'urgent',
      headline: 'Stripe status refresh can\'t run: no Stripe key is set',
      lines: ["New Stripe restrictions won't be picked up until it is."],
      action: 'set STRIPE_READONLY_KEY in Vercel (Production).',
    })
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }
  try {
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' as never })
    const s = await refreshStripeCapabilities(stripe)
    console.log(`[cron/refresh-stripe-capabilities] checked=${s.checked} connected=${s.connected} atRisk=${s.atRisk} restricted=${s.restricted} unknown=${s.unknown} changed=${s.changed}`)
    // Only a CHANGE is worth an alert, and only once per restaurant per transition —
    // a standing restriction is already visible on the admin screen and does not
    // need to be re-announced every hour. See lib/ops-alert.ts's rule.
    await resolveAlert('config:stripe-capability-key', 'Resolved: the key is set and the refresh ran.')
    // One thread per restaurant, opened when Stripe restricts it and closed when
    // Stripe lifts it. A standing restriction is on the admin screen already and
    // is never re-announced.
    for (const f of s.flips) {
      const key = `stripe-restricted:${String(f.restaurantReference).toLowerCase()}`
      if (f.to === 'restricted') {
        const name = (await restaurantName(f.restaurantReference)) ?? 'a restaurant'
        await alertOnce(key, {
          severity: 'warn',
          headline: `Stripe restricted ${name}`,
          lines: ["It can't take orders and is hidden from its locations page until Stripe lifts the restriction."],
          action: 'ask the restaurant to finish what Stripe is asking for in their Stripe dashboard.',
          link: SUGGESTIONS.accountManagement,
          context: { restaurantReference: f.restaurantReference, from: f.from, to: f.to },
        })
      } else if (f.from === 'restricted') {
        await resolveAlert(key, 'Resolved: Stripe lifted the restriction; it can take orders again.')
      }
    }
    await noteJobSuccess('refresh-stripe-capabilities')
    return NextResponse.json({ ok: true, ...s })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('[cron/refresh-stripe-capabilities] failed:', error)
    await noteJobFailure('refresh-stripe-capabilities', error)
    return NextResponse.json({ error: 'refresh failed' }, { status: 500 })
  }
}

// Every run is recorded in disco_cron_runs for NM OS Platform Health (lib/cron-runs.ts).
export const GET = withCronRun('refresh-stripe-capabilities', runGet)
