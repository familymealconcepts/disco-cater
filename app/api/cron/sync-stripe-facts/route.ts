import { NextRequest, NextResponse } from 'next/server'
import { stripeClient } from '../../../../lib/order/native-payment'
import { ordersDueForStripeSync, syncOrderStripeFacts } from '../../../../lib/order/stripe-facts'
import { withCronRun } from '../../../../lib/cron-runs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Copies what Stripe actually did with each Disco-processed order's money — fee,
// transfers, reversals, refunds — into disco_order_stripe_facts, which reports
// and the dashboard read (Peter, 2026-10-29, decisions 3 and 4). Read-only
// against Stripe. A batch per run, two orders at a time: the live account's rate
// limit is shared with checkout.
const BATCH = 40

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
  const refs = await ordersDueForStripeSync(BATCH)
  let synced = 0
  const failed: string[] = []
  let i = 0
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (i < refs.length) {
      const ref = refs[i++]
      try { if (await syncOrderStripeFacts(stripe, ref)) synced++ }
      catch (e) { failed.push(ref); console.error('[cron/sync-stripe-facts] order failed:', ref, e instanceof Error ? e.message : e) }
    }
  }))
  console.log(`[cron/sync-stripe-facts] due=${refs.length} synced=${synced} failed=${failed.length}`)
  return NextResponse.json({ ok: true, due: refs.length, synced, failed })
}

// Every run is recorded in disco_cron_runs for NM OS Platform Health (lib/cron-runs.ts).
export const GET = withCronRun('sync-stripe-facts', runGet)
