/**
 * Resolve every Stripe connected account to a restaurant_reference, without a
 * Dashboard lookup.
 *
 * Stripe display names are NOT trustworthy for this: three of the eight Two
 * Hands accounts carried the wrong location's name, and name-matching would
 * have put Franklin's account on Dallas. The only load-bearing evidence is the
 * payment trace — transfers to the connected account, back to the platform
 * charge that funded them, to the PaymentIntent, whose metadata carries
 * restaurantReference.
 *
 * Reads only. Writes one JSON artifact. A resolved id is evidence, not state:
 * nothing here touches disco_restaurant_overrides.
 */
import Stripe from 'stripe'
import { writeFileSync } from 'fs'
import { sql } from '../lib/db'

const OUT = 'data/stripe-account-resolutions.json'
const TRANSFERS_PER_ACCOUNT = 10 // not 1 — one transfer can be a refund or a test
const CONCURRENCY = 5            // Stripe live-mode reads allow 100/s; we peak at ~5

type Bucket = 'resolved' | 'shared-account' | 'no-transfers' | 'no-metadata' | 'error'
interface Resolution {
  stripeAccountId: string
  stripeDisplayName: string | null
  bucket: Bucket
  restaurantReference: string | null
  restaurantName: string | null
  references: { reference: string; restaurantName: string | null; transfers: number }[]
  evidence: { transferId: string; chargeId: string | null; paymentIntentId: string | null; reference: string | null }[]
  transfersSeen: number
  note: string | null
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

// Stripe 429s are expected to be rare at this volume, but a blind run that hits
// one and drops the account would silently under-report. Retry with backoff.
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let delay = 500
  for (let attempt = 0; ; attempt++) {
    try { return await fn() } catch (e) {
      const err = e as { statusCode?: number; type?: string }
      const retryable = err.statusCode === 429 || (err.statusCode ?? 0) >= 500
      if (!retryable || attempt >= 4) throw e
      console.warn(`  retry ${attempt + 1} on ${label} (${err.statusCode})`)
      await new Promise(r => setTimeout(r, delay))
      delay *= 2
    }
  }
}

async function main() {
  const key = process.env.STRIPE_READONLY_KEY || process.env.STRIPE_LIVE_SECRET_KEY
  if (!key) throw new Error('No Stripe key available.')
  if (key.startsWith('sk_test') || key.startsWith('rk_test')) {
    throw new Error('Key is TEST mode — a test-mode trace resolves nothing real. Aborting.')
  }
  const stripe = new Stripe(key)

  console.log('── enumerating connected accounts')
  const accounts: Stripe.Account[] = []
  for await (const a of stripe.accounts.list({ limit: 100 })) accounts.push(a)
  console.log(`   ${accounts.length} connected accounts`)

  console.log(`── tracing (${TRANSFERS_PER_ACCOUNT} transfers each, concurrency ${CONCURRENCY})`)
  let done = 0
  const results = await mapLimit(accounts, CONCURRENCY, async (acct): Promise<Resolution> => {
    const base: Resolution = {
      stripeAccountId: acct.id,
      stripeDisplayName: acct.business_profile?.name || acct.settings?.dashboard?.display_name || null,
      bucket: 'no-transfers', restaurantReference: null, restaurantName: null,
      references: [], evidence: [], transfersSeen: 0, note: null,
    }
    try {
      const transfers = await withRetry(() => stripe.transfers.list(
        { destination: acct.id, limit: TRANSFERS_PER_ACCOUNT, expand: ['data.source_transaction'] },
      ), `transfers ${acct.id}`)
      base.transfersSeen = transfers.data.length
      if (!transfers.data.length) return base

      const tally = new Map<string, number>()
      for (const t of transfers.data) {
        const charge = t.source_transaction as Stripe.Charge | null
        const piId = typeof charge?.payment_intent === 'string' ? charge.payment_intent : null
        let ref: string | null = null
        if (piId) {
          const pi = await withRetry(() => stripe.paymentIntents.retrieve(piId), `pi ${piId}`)
          ref = (pi.metadata?.restaurantReference as string | undefined)?.trim() || null
        }
        base.evidence.push({ transferId: t.id, chargeId: charge?.id ?? null, paymentIntentId: piId, reference: ref })
        if (ref) tally.set(ref, (tally.get(ref) ?? 0) + 1)
      }

      if (tally.size === 0) { base.bucket = 'no-metadata'; base.note = 'Transfers found, but no PaymentIntent carried metadata.restaurantReference.'; return base }
      base.references = [...tally.entries()].map(([reference, transfers]) => ({ reference, restaurantName: null, transfers }))
        .sort((a, b) => b.transfers - a.transfers)
      if (tally.size === 1) {
        base.bucket = 'resolved'
        base.restaurantReference = base.references[0].reference
      } else {
        // NOT a failure: an account funding two restaurants is a real finding.
        base.bucket = 'shared-account'
        base.note = `Transfers resolve to ${tally.size} distinct restaurant references — shared account.`
      }
      return base
    } catch (e) {
      base.bucket = 'error'
      base.note = e instanceof Error ? e.message : String(e)
      return base
    } finally {
      if (++done % 50 === 0) console.log(`   ${done}/${accounts.length}`)
    }
  })

  // Name every reference we saw, from Neon.
  const allRefs = [...new Set(results.flatMap(r => r.references.map(x => x.reference)))]
  const named = new Map<string, string>()
  if (allRefs.length) {
    const rows = await sql`SELECT restaurant_reference ref, name FROM disco_restaurant_cache WHERE restaurant_reference = ANY(${allRefs})`
    for (const r of rows as { ref: string; name: string }[]) named.set(r.ref, r.name)
  }
  for (const r of results) {
    for (const x of r.references) x.restaurantName = named.get(x.reference) ?? null
    if (r.restaurantReference) r.restaurantName = named.get(r.restaurantReference) ?? null
  }

  const counts = results.reduce<Record<string, number>>((a, r) => (a[r.bucket] = (a[r.bucket] ?? 0) + 1, a), {})
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    stripeMode: 'live',
    transfersPerAccount: TRANSFERS_PER_ACCOUNT,
    totalAccounts: accounts.length,
    counts,
    resolutions: results,
  }, null, 2) + '\n')
  console.log('\n── buckets'); console.table(counts)
  console.log(`written: ${OUT}`)
  process.exit(0)
}
main()
