// M6 — restaurant-funded promo support for Disco-native orders.
//
// The native charge is built DISCOUNTED from scratch (discountPct flows through
// priceNativeOrder → computeBreakdown, reducing both the customer total AND the
// restaurant transfer), so the restaurant absorbs the discount — exactly the
// restaurant-funded semantics. No PI patching / self-check is needed here (that
// exists only on the FM path in promo-apply.ts, which must reverse-engineer FM's
// PaymentIntent). Native is always a DIRECT destination charge (restaurant is
// merchant-of-record), so the DIRECT-only constraint is inherently satisfied.
//
// DISCO-funded codes are intentionally NOT handled here — they keep the restaurant's
// full payout and are absorbed by Disco via the existing post-charge redeem path
// (/api/promo/redeem). Phase 1 is percent-only (flat = a later phase).
import { sql } from './db'

export interface NativePromoResolution { id: number; pct: number }

// Look up + validate a RESTAURANT-funded percent code for this native restaurant.
// Mirrors promo-apply.ts resolveCode (active, validity window, global max_uses,
// percent 1-100), plus a defensive FAMILY_MEAL money-flow decline. Returns null
// (no discount) on any failure — the order still places at full price.
export async function resolveNativeRestaurantPromo(code: string, restaurantRef: string): Promise<NativePromoResolution | null> {
  const c = (code || '').trim()
  if (!c || !restaurantRef) return null
  const rows = (await sql`
    SELECT id, discount_value, discount_type, valid_from, valid_until, active, max_uses, uses_count
    FROM promo_codes
    WHERE UPPER(code) = UPPER(${c}) AND funded_by = 'RESTAURANT' AND restaurant_ref = ${restaurantRef}
    ORDER BY id DESC LIMIT 1
  `.catch(() => [])) as {
    id: number; discount_value: string | number; discount_type: string
    valid_from: string | null; valid_until: string | null; active: boolean
    max_uses: number | null; uses_count: number
  }[]
  const p = rows[0]
  if (!p || !p.active) return null
  if (p.discount_type !== 'percent') return null // Phase 1: percent only
  const now = Date.now()
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return null
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return null
  if (p.max_uses != null && p.uses_count >= p.max_uses) return null
  const pct = Number(p.discount_value)
  if (!(pct >= 1 && pct <= 100)) return null
  // Defense-in-depth: an explicit FAMILY_MEAL money-flow means the restaurant is not
  // merchant-of-record — decline (restaurant-funded is DIRECT-only, permanent rule).
  const mf = (await sql`SELECT money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantRef} LIMIT 1`.catch(() => [])) as { money_flow: string | null }[]
  if (mf[0]?.money_flow === 'FAMILY_MEAL') return null
  return { id: p.id, pct }
}

// Record the promo use + increment the global counter, idempotent per order so a
// retry can't double-count. Best-effort: the charge is already discounted, so a
// bookkeeping hiccup must never throw back and misroute a placed order.
export async function recordNativeRestaurantPromoUse(args: {
  promoId: number; orderRef: string; userEmail: string; discountDollars: number
  restaurantRef: string; paymentIntentId?: string | null
}): Promise<void> {
  try {
    const existing = (await sql`SELECT 1 FROM promo_code_uses WHERE promo_code_id = ${args.promoId} AND order_ref = ${args.orderRef} LIMIT 1`) as unknown[]
    if (existing.length) return
    await sql`
      INSERT INTO promo_code_uses (promo_code_id, user_email, order_ref, discount_applied, refund_status, funded_by, restaurant_ref, stripe_payment_intent_id)
      VALUES (${args.promoId}, ${args.userEmail || ''}, ${args.orderRef}, ${args.discountDollars}, 'not_applicable', 'RESTAURANT', ${args.restaurantRef}, ${args.paymentIntentId ?? null})
    `
    await sql`UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ${args.promoId}`
  } catch (e) {
    console.error('[promo-native] use recording failed (charge already discounted):', e instanceof Error ? e.message : e)
  }
}
