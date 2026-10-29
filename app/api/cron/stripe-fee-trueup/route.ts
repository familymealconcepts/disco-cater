import { NextRequest, NextResponse } from 'next/server'
import { stripeClient } from '../../../../lib/order/native-payment'
import { runFeeTrueups } from '../../../../lib/order/stripe-fee-trueup'
import { withCronRun } from '../../../../lib/cron-runs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Settles each new Disco payment to Stripe's ACTUAL fee (Peter, 2026-10-29,
// decision 3): lib/order/stripe-fee-trueup.ts. Does nothing until
// STRIPE_FEE_TRUEUP_ENABLED=1 and STRIPE_FEE_TRUEUP_SINCE are set — Peter
// switches it on after the test-mode report.
function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

async function runGet(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY)
  if (!stripe) return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  const r = await runFeeTrueups(stripe)
  console.log(`[cron/stripe-fee-trueup] enabled=${r.enabled} checked=${r.checked} ${JSON.stringify(r.outcomes)}`)
  return NextResponse.json({ ok: true, ...r })
}

export const GET = withCronRun('stripe-fee-trueup', runGet)
