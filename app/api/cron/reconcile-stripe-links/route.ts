// Cron: link a converted restaurant's Stripe account when — and only when —
// the account itself names the restaurant. See lib/stripe-link-reconcile.ts for
// the matching rule and, more importantly, for the two signals that were
// measured and REJECTED (account email: 8 wrong payout destinations in 179
// matches; business name: "Black Seed Bagels" → "Black Market BBQ LLC").
//
// WHY DAILY AND NOT HOURLY. A refusal is the normal outcome here, so the job
// reports its full digest every run; hourly that is noise, and a noisy alert is
// one nobody reads. Restaurants do not connect Stripe every hour.
//
// REQUIRED ENV (set in Vercel):
//   CRON_SECRET          shared secret. Vercel Cron sends it as
//                        `Authorization: Bearer ${CRON_SECRET}`.
//   STRIPE_READONLY_KEY  (or STRIPE_SECRET_KEY) — a LIVE key. Reads only: this
//                        job never writes to Stripe, it writes Neon.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin, authorized by the admin session cookie, or by the
//            same Bearer secret. Accepts `?dryRun=1`, which resolves and
//            health-checks exactly as a real run does but writes nothing —
//            the right way to inspect what it would do to payout destinations
//            before letting it do it.
import { NextRequest, NextResponse } from 'next/server'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'
import { reconcileStripeLinks } from '../../../../lib/stripe-link-reconcile'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now()
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  try {
    const result = await reconcileStripeLinks({ dryRun })
    console.log('[reconcile-stripe-links] done:', JSON.stringify({
      candidates: result.candidates, linked: result.linked.length,
      refused: result.refused.length, conflicts: result.conflicts.length,
      scanned: result.stripeAccountsScanned, budgetStopped: result.budgetStopped,
      dryRun, durationMs: result.durationMs,
    }))
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('[reconcile-stripe-links] failed:', error)
    // Alert, never a silent 500 — the same omission that let sync-fm-orders
    // fail every hour for four and a half days with no signal anywhere.
    await alertOps(`reconcile-stripe-links FAILED: ${error}`)
    return NextResponse.json({ success: false, error, duration_ms: Date.now() - startedAt }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle(req)
}

export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || !!getAdminTokenFromRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle(req)
}
