import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import { stripeClient } from '../../../../lib/order/native-payment'
import { reconcileNativePayments, DEFAULT_RECONCILIATION_LOOKBACK_HOURS } from '../../../../lib/order/native-payment-reconciliation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// The gap the RESERVED-expiry sweep can't close: it only ever looks at orders
// currently sitting in RESERVED, so a payment that succeeded in Stripe but got
// stuck at a DIFFERENT stage (or whose order row never got created at all)
// would never surface there. This is the "does Stripe's truth match ours"
// check that doesn't depend on order status — same shape as the FM
// reconciliation sweep and the expired-invite badge. Built after finding
// discocater.com has NO registered Stripe webhook endpoint at all (checked
// Stripe's own webhook_endpoints list) — every succeeded native payment has
// been relying entirely on the client's direct confirm-payment call landing;
// this is the safety net for whenever it doesn't.
function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY)
  if (!stripe) {
    console.error('[cron/reconcile-native-payments] STRIPE_SECRET_KEY not configured — cannot reconcile, skipping run')
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }

  try {
    await runDiscoOrderMigrations()
    const lookbackEnv = parseInt(process.env.NATIVE_PAYMENT_RECONCILIATION_LOOKBACK_HOURS || '', 10)
    const lookbackHours = Number.isFinite(lookbackEnv) && lookbackEnv > 0 ? lookbackEnv : DEFAULT_RECONCILIATION_LOOKBACK_HOURS
    const summary = await reconcileNativePayments(stripe, lookbackHours)
    console.log(
      `[cron/reconcile-native-payments] checkedStripeSucceeded=${summary.checkedStripeSucceeded} checkedLocalPaid=${summary.checkedLocalPaid} mismatches=${summary.mismatches.length} (lookbackHours=${lookbackHours})`,
    )
    return NextResponse.json({ ok: true, lookbackHours, ...summary })
  } catch (err) {
    console.error('[cron/reconcile-native-payments] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Reconciliation run failed' }, { status: 500 })
  }
}
