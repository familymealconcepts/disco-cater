// ONE-TIME catch-up (Peter, 2026-11-20): put the order number and customer name on every payment in
// restaurants' own Stripe accounts since a date. From then on the Stripe webhook labels each new one
// (transfer.created → lib/order/restaurant-payment-label.ts).
//
// Two kinds of payment reach a restaurant's account:
//   1. transfers from the platform (Disco and FamilyMeal checkouts, edits, manual payouts) — every
//      platform transfer since --since is labelled from the order it paid;
//   2. FamilyMeal's direct invoices, charged on the restaurant's own account — labelled from the
//      invoice's orderReference, for every connected account Disco knows.
// Transfers that name no order (sent by hand from the Dashboard) are listed and left alone.
//
// MOVES NO MONEY. Writes only description + metadata on the restaurant's payment, only when different.
// Safe to re-run.
//   npx tsx scripts/backfill-restaurant-payment-labels.ts                       # dry run, read-only key
//   npx tsx scripts/backfill-restaurant-payment-labels.ts --apply               # writes (live key)
//   ... --since 2026-09-01 (default)   --account acct_…  (one restaurant only)
import { config } from 'dotenv'; config({ path: '.env.local', quiet: true } as never)
import Stripe from 'stripe'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const apply = process.argv.includes('--apply')
const since = arg('--since') || '2026-09-01'
const onlyAccount = arg('--account') || null
// Two at a time: the live account's rate limit is shared with checkout.
const CONCURRENCY = 2

async function main() {
  const key = apply ? process.env.STRIPE_LIVE_SECRET_KEY || '' : process.env.STRIPE_READONLY_KEY || ''
  if (apply && !key.startsWith('sk_live_')) throw new Error('--apply needs STRIPE_LIVE_SECRET_KEY')
  if (!apply && !key.startsWith('rk_')) throw new Error('dry run needs the read-only STRIPE_READONLY_KEY')
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia', maxNetworkRetries: 5 } as never)
  const { sql } = await import('../lib/db')
  const { labelTransferPayment, labelDirectCharge, chargeInvoice } = await import('../lib/order/restaurant-payment-label')
  const gte = Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000)
  if (!Number.isFinite(gte)) throw new Error(`bad --since ${since}`)
  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — payments since ${since}${onlyAccount ? ` for ${onlyAccount}` : ''}`)

  const tally: Record<string, number> = {}
  const unlabelled: string[] = []
  const failed: string[] = []
  const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1 }

  // 1. Platform transfers.
  const transfers: Stripe.Transfer[] = []
  for await (const t of stripe.transfers.list({ created: { gte }, limit: 100, ...(onlyAccount ? { destination: onlyAccount } : {}) })) transfers.push(t)
  console.log(`${transfers.length} transfers`)
  let i = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < transfers.length) {
      const t = transfers[i++]
      try {
        const r = await labelTransferPayment(stripe, t, { dryRun: !apply })
        count(`transfer:${r.outcome}`)
        if (r.outcome === 'no-order') unlabelled.push(`${t.id} $${(t.amount / 100).toFixed(2)} → ${t.destination} ${new Date(t.created * 1000).toISOString().slice(0, 10)}`)
        else if (r.outcome === 'labelled' && !apply && tally['transfer:labelled'] <= 5) console.log(`  would label ${t.destination_payment}: ${r.description}`)
      } catch (e) {
        count('transfer:failed'); failed.push(`${t.id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }))

  // 2. FamilyMeal direct invoices on each restaurant's own account.
  const accounts = onlyAccount ? [onlyAccount] : ((await sql`
    SELECT DISTINCT stripe_account_id FROM disco_restaurant_overrides WHERE stripe_account_id LIKE 'acct_%'
  `) as { stripe_account_id: string }[]).map(r => r.stripe_account_id)
  console.log(`${accounts.length} connected accounts to scan for direct invoices`)
  let a = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (a < accounts.length) {
      const acct = accounts[a++]
      try {
        for await (const c of stripe.charges.list({ created: { gte }, limit: 100 }, { stripeAccount: acct })) {
          // A transfer's payment (py_…) has source_transfer and was handled above; only direct charges here.
          if (c.status !== 'succeeded' || (c as unknown as { source_transfer?: unknown }).source_transfer || !chargeInvoice(c)) continue
          const r = await labelDirectCharge(stripe, acct, c, { dryRun: !apply })
          count(`direct:${r.outcome}`)
          if (r.outcome === 'no-order') unlabelled.push(`${c.id} $${(c.amount / 100).toFixed(2)} on ${acct} (direct invoice)`)
        }
      } catch (e) {
        count('direct:failed'); failed.push(`${acct}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }))

  console.log('\nResult:', tally)
  if (unlabelled.length) console.log(`\nNo order found (left as they are), ${unlabelled.length}:\n  ${unlabelled.join('\n  ')}`)
  if (failed.length) console.log(`\nFailed, ${failed.length}:\n  ${failed.slice(0, 50).join('\n  ')}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
