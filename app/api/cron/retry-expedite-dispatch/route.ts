import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import { alertOps } from '../../../../lib/ops-alert'
import { sweepFailedExpediteDispatches, DISPATCH_MARGIN_MINUTES } from '../../../../lib/order/expedite-dispatch-sweep'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Retries Expedite dispatches that the live path never completed. The reasoning for the whole
// mechanism — why one-shot dispatch strands orders, why the gate is the PICKUP time rather than
// the delivery window, and why the margin is 20 minutes — is in
// lib/order/expedite-dispatch-sweep.ts. This file is the schedule and the plumbing.
//
// EVERY 15 MINUTES, at 7/22/37/52 past.
//
// Frequency is set by how long an outage may hide, not by how fast a single order needs help. The
// failure this exists for is systemic: credentials wrong, dlivrd down, a deploy that breaks
// signing. Every order paid during such a window is stranded, so the question is how much of a
// morning can pass before someone is told. Fifteen minutes means an outage beginning at 06:00 is
// surfaced by 06:15 — the same morning, with hours of runway before the earliest catering windows.
//
// It is not expensive. The scan is one indexed query that normally returns zero rows, and dlivrd
// is contacted ONLY when there is an actual stranded order to rescue — in the last 90 days that
// would have been four calls in total, all on one day. A healthy fleet generates no outbound
// traffic at all, so a shorter interval costs nothing but buys less than the alerting already
// does; a longer one risks letting a breakfast-time outage run past the windows it ruins.
//
// The offset minutes keep it off the top of the hour, where sync-fm-orders, order-reminders,
// scheduled-reports, expire-reserved-native-orders, reconcile-native-payments, check-bare-orders
// and recurring-orders all fire together.
function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await runDiscoOrderMigrations()
    const s = await sweepFailedExpediteDispatches()

    if (s.skippedDisabled) {
      console.log('[cron/retry-expedite-dispatch] EXPEDITE_NATIVE_DISPATCH_ENABLED is off — no-op')
      return NextResponse.json({ ok: true, skipped: 'dispatch disabled' })
    }

    console.log(
      `[cron/retry-expedite-dispatch] scanned=${s.scanned} dispatched=${s.dispatched.length} ` +
      `tooLate=${s.tooLate.length} silentlyStale=${s.silentlyStale.length} failed=${s.failed.length} unbuildable=${s.unbuildable.length} ` +
      `(margin=${DISPATCH_MARGIN_MINUTES}m)`,
    )
    return NextResponse.json({
      ok: true,
      marginMinutes: DISPATCH_MARGIN_MINUTES,
      scanned: s.scanned,
      dispatched: s.dispatched.map(c => c.orderNumber),
      tooLate: s.tooLate.map(c => ({ order: c.orderNumber, minutesToPickup: c.minutesToPickup })),
      silentlyStale: s.silentlyStale.map(c => c.orderNumber),
      failed: s.failed.map(c => c.orderNumber),
      unbuildable: s.unbuildable.map(c => c.orderNumber),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[cron/retry-expedite-dispatch] failed:', message)
    // The sweep silently failing would recreate the exact blind spot it exists to close: nobody
    // finds out that nobody is checking.
    await alertOps('expedite sweep: THE SWEEP ITSELF FAILED — stranded orders are not being retried', { error: message })
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
