// M3 conversion tooling — resolve a restaurant's real Stripe connected account id
// from its OWN settled payment history, so a manual Stripe-dashboard search by
// business name isn't the only path. No FM API exposes a connected account id
// directly, so this reads the one place a real destination-charge PaymentIntent
// would have recorded it: disco_stripe_payments (joined through disco_orders when
// the restaurant_reference column itself is blank on an older row), then asks
// Stripe directly for that PaymentIntent's transfer_data.destination — the same
// technique used ad hoc for Pelican Delicatessen/Glen Rock, made reusable.
//
// Read-only. Never guesses, never falls back to money_flow or any other proxy —
// only a real destination charge's own transfer_data counts as a resolution.
import Stripe from 'stripe'
import { sql } from './db'

function getStripe(): Stripe {
  return new Stripe(
    process.env.STRIPE_SECRET_KEY || '',
    { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1],
  )
}

export interface StripeResolutionResult {
  accountId: string | null
  source: 'payment_intent' | 'charge' | null
  // The Neon record (payment_intent/charge id) that led to the resolution, or the
  // reason nothing could be resolved — always populated so a caller can tell
  // "no history at all" apart from "history exists but the charge lookup failed."
  detail: string
}

// Candidate settled payments for a restaurant — any disco_stripe_payments row with
// a real payment_intent_id or charge_id, matched by the row's own restaurant_reference
// OR (for older rows that never got it populated) by joining through disco_orders.
// Most recent first — a more recent charge is more likely to still reflect the
// restaurant's current connected account than an old one.
async function candidatePaymentRefs(restaurantReference: string): Promise<{ paymentIntentId: string | null; chargeId: string | null }[]> {
  const rows = (await sql`
    SELECT DISTINCT sp.stripe_payment_intent_id, sp.charge_id, sp.created_at
    FROM disco_stripe_payments sp
    LEFT JOIN disco_orders o ON o.reference = sp.order_reference
    WHERE (sp.restaurant_reference = ${restaurantReference}::uuid OR o.restaurant_reference = ${restaurantReference}::uuid)
      AND (sp.stripe_payment_intent_id IS NOT NULL OR sp.charge_id IS NOT NULL)
    ORDER BY sp.created_at DESC
    LIMIT 5
  `.catch(() => [])) as { stripe_payment_intent_id: string | null; charge_id: string | null; created_at: string }[]
  return rows.map(r => ({ paymentIntentId: r.stripe_payment_intent_id, chargeId: r.charge_id }))
}

export async function resolveStripeAccountFromHistory(
  restaurantReference: string,
  stripe: Stripe = getStripe(),
): Promise<StripeResolutionResult> {
  const candidates = await candidatePaymentRefs(restaurantReference)
  if (!candidates.length) {
    return { accountId: null, source: null, detail: 'No settled payment on record in disco_stripe_payments — needs manual Stripe-dashboard lookup.' }
  }

  for (const c of candidates) {
    if (c.paymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(c.paymentIntentId)
        const dest = pi.transfer_data?.destination
        if (dest) {
          const acctId = typeof dest === 'string' ? dest : dest.id
          return { accountId: acctId, source: 'payment_intent', detail: `Resolved from PaymentIntent ${c.paymentIntentId}.` }
        }
      } catch (e) {
        // This specific PaymentIntent didn't resolve — try the next candidate
        // rather than giving up on the whole restaurant.
        console.error(`[stripe-account-resolution] PI ${c.paymentIntentId} retrieve failed:`, e instanceof Error ? e.message : e)
      }
    }
    if (c.chargeId) {
      try {
        const ch = await stripe.charges.retrieve(c.chargeId)
        const dest = ch.transfer_data?.destination
        if (dest) {
          const acctId = typeof dest === 'string' ? dest : dest.id
          return { accountId: acctId, source: 'charge', detail: `Resolved from charge ${c.chargeId}.` }
        }
      } catch (e) {
        console.error(`[stripe-account-resolution] charge ${c.chargeId} retrieve failed:`, e instanceof Error ? e.message : e)
      }
    }
  }

  return {
    accountId: null,
    source: null,
    detail: `${candidates.length} settled payment(s) on record, but none carried a transfer_data.destination (likely platform-charged, not a destination charge) — needs manual Stripe-dashboard lookup.`,
  }
}
