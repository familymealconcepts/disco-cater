import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import { stripeClient } from '../../../../lib/order/native-payment'
import { expireStaleNativeReservedOrders, DEFAULT_RESERVED_EXPIRY_MINUTES } from '../../../../lib/order/native-reserved-expiry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Native RESERVED orders never expire on their own (see native-reserved-expiry.ts
// for why) — this cron is that missing job. Runs hourly; with the 30-minute
// default age threshold, a stale order is caught within ~30-90 minutes of
// abandonment, which is what actually matters here (releasing a held capacity
// slot / promo use promptly), not sub-minute precision like FM's 5-minute sweep
// (tuned for a slot-selection page, not a card payment that can legitimately
// run long on 3D Secure).
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
    console.error('[cron/expire-reserved-native-orders] STRIPE_SECRET_KEY not configured — cannot verify PaymentIntent state, skipping run')
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }

  try {
    await runDiscoOrderMigrations()
    const minutesEnv = parseInt(process.env.NATIVE_RESERVED_EXPIRY_MINUTES || '', 10)
    const minutes = Number.isFinite(minutesEnv) && minutesEnv > 0 ? minutesEnv : DEFAULT_RESERVED_EXPIRY_MINUTES
    const summary = await expireStaleNativeReservedOrders(stripe, minutes)
    console.log(
      `[cron/expire-reserved-native-orders] checked=${summary.checked} reconciled=${summary.reconciled} expired=${summary.expired} skipped=${summary.skipped} (minutes=${minutes})`,
    )
    return NextResponse.json({ ok: true, minutes, ...summary })
  } catch (err) {
    console.error('[cron/expire-reserved-native-orders] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
