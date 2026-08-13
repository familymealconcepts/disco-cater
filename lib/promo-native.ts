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
import crypto from 'node:crypto'
import { sql } from './db'
import { resolveEffectiveDiscountPct } from './promo-pricing'
import { countPriorPaidOrders } from './pricing/native-order'

export interface NativePromoResolution { id: number; pct: number; maxUses: number | null; maxUsesPerUser: number }

// Look up + validate a RESTAURANT-funded code (flat-$ or percent, with cap/min-order/
// first-time enforcement) for this native restaurant. Mirrors promo-apply.ts
// resolveCode (active, validity window, global max_uses), plus a defensive
// FAMILY_MEAL money-flow decline. Returns null (no discount) on any failure — the
// order still places at full price.
//
// subtotal is required now (not optional) because min_order_subtotal and the
// flat-$/cap-to-pct conversion both need it — every caller already computes
// subtotal before resolving the promo (see priceNativeCart). The returned `pct` is
// the EFFECTIVE percent (see resolveEffectiveDiscountPct in lib/promo-pricing.ts),
// already accounting for discount_type/max_discount_cap — callers still just feed
// it into discountedBase/computeBreakdown exactly as before, unchanged.
//
// userEmail is used for a best-effort PREVIEW of the per-user cap AND first_time_only
// only — the pricing preview (priceNativeCart with no known customer yet) calls this
// with '' and both checks are skipped there; a wrong/blank email here can only make
// the preview show "valid" when it later isn't, never the reverse. The real gate is
// reserveNativeRestaurantPromoUse below, which re-checks both caps atomically at
// the moment of placement — this function alone never authorizes a charge.
export async function resolveNativeRestaurantPromo(code: string, restaurantRef: string, subtotal: number, userEmail?: string): Promise<NativePromoResolution | null> {
  const c = (code || '').trim()
  if (!c || !restaurantRef || subtotal <= 0) return null
  const rows = (await sql`
    SELECT id, discount_value, discount_type, max_discount_cap, min_order_subtotal, first_time_only,
           valid_from, valid_until, active, max_uses, uses_count, max_uses_per_user
    FROM promo_codes
    WHERE UPPER(code) = UPPER(${c}) AND funded_by = 'RESTAURANT' AND restaurant_ref = ${restaurantRef}
    ORDER BY id DESC LIMIT 1
  `.catch(() => [])) as {
    id: number; discount_value: string | number; discount_type: 'flat' | 'percent'
    max_discount_cap: string | number | null; min_order_subtotal: string | number | null; first_time_only: boolean
    valid_from: string | null; valid_until: string | null; active: boolean
    max_uses: number | null; uses_count: number; max_uses_per_user: number
  }[]
  const p = rows[0]
  if (!p || !p.active) return null
  const now = Date.now()
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return null
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return null
  if (p.max_uses != null && p.uses_count >= p.max_uses) return null
  const minOrder = p.min_order_subtotal == null ? null : Number(p.min_order_subtotal)
  if (minOrder != null && subtotal < minOrder) return null // evaluated against the PRE-discount subtotal
  const userKey = (userEmail || '').trim().toLowerCase()
  if (userKey) {
    const used = (await sql`SELECT COUNT(*)::int AS c FROM promo_code_uses WHERE promo_code_id = ${p.id} AND LOWER(user_email) = ${userKey}`.catch(() => [{ c: 0 }])) as { c: number }[]
    if ((used[0]?.c ?? 0) >= p.max_uses_per_user) return null
    if (p.first_time_only) {
      // Restaurant-scoped, same definition the lead-gen fee tier uses — NOT
      // platform-wide FM history (that's a different, wrong question here).
      const prior = await countPriorPaidOrders(userKey, restaurantRef)
      if (prior > 0) return null
    }
  }
  const discountValue = Number(p.discount_value)
  const maxDiscountCap = p.max_discount_cap == null ? null : Number(p.max_discount_cap)
  const pct = resolveEffectiveDiscountPct(subtotal, p.discount_type, discountValue, maxDiscountCap)
  if (!(pct > 0 && pct <= 100)) return null
  // Defense-in-depth: an explicit FAMILY_MEAL money-flow means the restaurant is not
  // merchant-of-record — decline (restaurant-funded is DIRECT-only, permanent rule).
  const mf = (await sql`SELECT money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantRef} LIMIT 1`.catch(() => [])) as { money_flow: string | null }[]
  if (mf[0]?.money_flow === 'FAMILY_MEAL') return null
  return { id: p.id, pct, maxUses: p.max_uses, maxUsesPerUser: p.max_uses_per_user }
}

export type ReserveResult = { ok: true; reservationId: number } | { ok: false; reason: 'max_uses' | 'max_uses_per_user' }

// Atomically reserve one use of a restaurant-funded promo — call this BEFORE
// creating the Stripe charge, not after. Both caps are enforced in ONE
// statement via data-modifying CTEs, which is what makes this race-safe:
//   - capped_update runs the global-cap check AND increment together as a
//     single conditional UPDATE. Postgres takes a row lock on the promo_codes
//     row for the duration of the UPDATE, so two concurrent reservations for
//     the SAME code serialize against each other — the second one only
//     evaluates its WHERE clause after the first has committed (or rolled
//     back), never against a stale uses_count.
//   - user_count reads the per-user history and the final INSERT only
//     produces a row when user_count is still under cap AND capped_update
//     produced a row (the FROM clause is a cross join of both CTEs — zero
//     rows in either means zero rows out).
// A placeholder order_ref is used because the real one doesn't exist until
// placeAndPayNativeOrder runs — see finalizeNativeRestaurantPromoUse /
// releaseNativeRestaurantPromoUse for the two ways this reservation resolves.
export async function reserveNativeRestaurantPromoUse(args: {
  promoId: number; userEmail: string; maxUses: number | null; maxUsesPerUser: number; restaurantRef: string
}): Promise<ReserveResult> {
  const userKey = (args.userEmail || '').trim().toLowerCase()
  const placeholderRef = `PENDING:${crypto.randomUUID()}`
  const rows = (await sql`
    WITH capped_update AS (
      UPDATE promo_codes SET uses_count = uses_count + 1
      WHERE id = ${args.promoId} AND (${args.maxUses}::int IS NULL OR uses_count < ${args.maxUses})
      RETURNING id
    ),
    user_count AS (
      SELECT COUNT(*)::int AS c FROM promo_code_uses
      WHERE promo_code_id = ${args.promoId} AND LOWER(user_email) = ${userKey}
    )
    INSERT INTO promo_code_uses (promo_code_id, user_email, order_ref, discount_applied, refund_status, funded_by, restaurant_ref)
    SELECT ${args.promoId}, ${userKey}, ${placeholderRef}, 0, 'not_applicable', 'RESTAURANT', ${args.restaurantRef}
    FROM capped_update, user_count
    WHERE user_count.c < ${args.maxUsesPerUser}
    RETURNING id
  `) as { id: number }[]

  if (rows.length > 0) return { ok: true, reservationId: rows[0].id }

  // The atomic decision above is already final — this second read is only to
  // pick the right error message; a race here can't un-make that decision.
  const check = (await sql`SELECT uses_count, max_uses FROM promo_codes WHERE id = ${args.promoId}`) as { uses_count: number; max_uses: number | null }[]
  const c = check[0]
  if (c && c.max_uses != null && c.uses_count >= c.max_uses) return { ok: false, reason: 'max_uses' }
  return { ok: false, reason: 'max_uses_per_user' }
}

// Attach the real order once placement succeeds. Best-effort: the charge is
// already placed and discounted: a bookkeeping hiccup here must never throw
// back and misroute a placed order — the reservation still correctly holds
// the cap slot even if this particular UPDATE fails.
export async function finalizeNativeRestaurantPromoUse(reservationId: number, args: {
  orderRef: string; discountDollars: number; paymentIntentId?: string | null
}): Promise<void> {
  try {
    await sql`
      UPDATE promo_code_uses
      SET order_ref = ${args.orderRef}, discount_applied = ${args.discountDollars}, stripe_payment_intent_id = ${args.paymentIntentId ?? null}
      WHERE id = ${reservationId}
    `
  } catch (e) {
    console.error('[promo-native] finalize failed (reservation still holds the cap slot):', e instanceof Error ? e.message : e)
  }
}

// Give back a reservation whose order never actually placed (e.g. the charge
// failed after the reservation succeeded) — otherwise a failed attempt would
// permanently burn a slot nobody actually used.
export async function releaseNativeRestaurantPromoUse(reservationId: number, promoId: number): Promise<void> {
  try {
    await sql`DELETE FROM promo_code_uses WHERE id = ${reservationId}`
    await sql`UPDATE promo_codes SET uses_count = GREATEST(0, uses_count - 1) WHERE id = ${promoId}`
  } catch (e) {
    console.error('[promo-native] release failed:', e instanceof Error ? e.message : e)
  }
}
