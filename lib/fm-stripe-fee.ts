import Stripe from 'stripe'

/**
 * The REAL Stripe fee of an order FamilyMeal charged (Peter, 23 Oct 2026).
 *
 * FM's order API has no Stripe fee and its only route that does 500s for our
 * service identity (see scripts/backfill-fm-sale-transaction-fees.ts), and FM's
 * database is reachable only through a laptop tunnel. But FM charges on the
 * SAME Stripe platform account as Disco, and every FM PaymentIntent carries the
 * order's FM reference in metadata.orderReference — and, since mid-2026,
 * FM's own recorded fee in metadata.stripe_fee. So the fee is read from Stripe:
 * that recorded fee, else the charge's balance transaction. Read-only (search + retrieve); never derived from a percentage
 * (see memory: deriving reproduced only 86.5% of known fees exactly).
 *
 * ORIGINAL sale only: when an order has several succeeded PaymentIntents (an
 * edit charged the difference), the EARLIEST is the original sale — the same
 * rule the FM-table backfill used ("ORIGINAL only").
 */

let client: Stripe | null = null
function stripe(): Stripe | null {
  if (client) return client
  const key = (process.env.STRIPE_READONLY_KEY || process.env.STRIPE_SECRET_KEY || '').replace(/^"|"$/g, '')
  if (!key) return null
  client = new Stripe(key)
  return client
}

export type FmStripeFee = { fee: number; paymentIntentId: string } | null

export async function lookupFmStripeFee(fmOrderReference: string | null | undefined): Promise<FmStripeFee> {
  const ref = String(fmOrderReference || '').trim()
  const s = stripe()
  if (!s || !/^[0-9a-f-]{36}$/i.test(ref)) return null
  try {
    // Search is rate-limited more tightly than other reads; back off and retry
    // rather than recording "unknown" for a fee Stripe does have.
    let res: Stripe.ApiSearchResult<Stripe.PaymentIntent> | null = null
    for (let attempt = 0; ; attempt++) {
      try {
        res = await s.paymentIntents.search({
          query: `metadata['orderReference']:'${ref}' AND status:'succeeded'`,
          limit: 10,
          expand: ['data.latest_charge.balance_transaction'],
        })
        break
      } catch (e) {
        const rate = (e as { type?: string; statusCode?: number })?.statusCode === 429 || /rate limit/i.test(String((e as Error)?.message))
        if (!rate || attempt >= 4) throw e
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
    const pis = res.data.filter(p => p.metadata?.orderReference === ref).sort((a, b) => a.created - b.created)
    const pi = pis[0]
    const ch = pi?.latest_charge as Stripe.Charge | null | undefined
    const bt = ch?.balance_transaction as Stripe.BalanceTransaction | null | undefined
    if (!pi) return null
    // FM writes its own recorded fee into metadata.stripe_fee — the figure its
    // table holds and its transfer was computed from. Prefer it; fall back to
    // the balance transaction only for a PaymentIntent without that metadata.
    // (On 2022–24 PaymentIntents, which carry no metadata, the balance
    // transaction can be a cent below FM's recorded fee.)
    const meta = Number(pi.metadata?.stripe_fee)
    if (pi.metadata?.stripe_fee != null && Number.isFinite(meta)) return { fee: Math.round(meta * 100) / 100, paymentIntentId: pi.id }
    if (!bt || typeof bt.fee !== 'number') return null
    return { fee: bt.fee / 100, paymentIntentId: pi.id }
  } catch (e) {
    console.error('[fm-stripe-fee] lookup failed (fee left unknown):', ref, e instanceof Error ? e.message : e)
    return null
  }
}
