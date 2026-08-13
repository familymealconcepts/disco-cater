import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations, withDiscoTables } from '../../../../lib/db'
import { r2, resolveEffectiveDiscountPct } from '../../../../lib/promo-pricing'
import { countPriorPaidOrders } from '../../../../lib/pricing/native-order'

export const runtime = 'nodejs'

interface PromoRow {
  id: number
  code: string
  discount_type: 'flat' | 'percent'
  discount_value: string | number
  scope: 'global' | 'restaurant'
  restaurant_ref: string | null
  funded_by: 'DISCO' | 'RESTAURANT'
  max_uses: number | null
  uses_count: number
  max_uses_per_user: number
  first_time_only: boolean
  min_order_subtotal: string | number | null
  max_discount_cap: string | number | null
  valid_from: string
  valid_until: string | null
  active: boolean
}

const n = (v: string | number | null | undefined): number | null => {
  if (v == null) return null
  const x = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(x) ? x : null
}

// POST /api/promo/validate
// { code, restaurantRef, orderSubtotal, orderTotal, userEmail }
// isFirstTimeUser is no longer read here — first_time_only is now resolved
// server-side via countPriorPaidOrders (restaurant-scoped), not a client-supplied,
// platform-wide boolean. A caller that still sends it is harmlessly ignored.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ valid: false, message: 'Invalid request.' }, { status: 400 }) }

  const code = String(body.code || '').trim()
  const restaurantRef = body.restaurantRef ? String(body.restaurantRef) : ''
  const orderSubtotal = n(body.orderSubtotal as number) ?? 0
  const orderTotal = n(body.orderTotal as number) ?? 0
  const userEmail = String(body.userEmail || '').trim().toLowerCase()

  if (!code) return NextResponse.json({ valid: false, message: 'Enter a promo code.' }, { status: 400 })

  // (1) code exists — 404 if not. Codes are now unique per (restaurant, code),
  // and the same code string can exist as a global code AND as different
  // restaurants' codes. Scope the lookup to this restaurant's own code or a
  // global one, preferring the restaurant-specific match.
  // Runs while the buyer types a code at checkout. Eagerly awaiting
  // runMigrations() (57 statements) meant a cold lambda could time out or error
  // here and report a perfectly valid code as invalid.
  const rows = (await withDiscoTables(() => sql`
    SELECT * FROM promo_codes
    WHERE UPPER(code) = UPPER(${code})
      AND (restaurant_ref IS NULL OR restaurant_ref = ${restaurantRef})
    ORDER BY (restaurant_ref IS NOT NULL) DESC, id DESC
    LIMIT 1
  `, runMigrations)) as PromoRow[]
  const promo = rows[0]
  if (!promo) return NextResponse.json({ valid: false, message: 'That promo code doesn’t exist.' }, { status: 404 })

  // (2) active
  if (!promo.active) return NextResponse.json({ valid: false, message: 'This promo code is no longer active.' })

  // (3) valid_from <= NOW() <= valid_until
  const now = Date.now()
  if (promo.valid_from && new Date(promo.valid_from).getTime() > now) {
    return NextResponse.json({ valid: false, message: 'This promo code isn’t active yet.' })
  }
  if (promo.valid_until && new Date(promo.valid_until).getTime() < now) {
    return NextResponse.json({ valid: false, message: 'This promo code has expired.' })
  }

  // (4) uses_count < max_uses if set
  if (promo.max_uses != null && promo.uses_count >= promo.max_uses) {
    return NextResponse.json({ valid: false, message: 'This promo code has reached its usage limit.' })
  }

  // (5) restaurant scope must match
  if (promo.scope === 'restaurant' && promo.restaurant_ref && promo.restaurant_ref !== restaurantRef) {
    return NextResponse.json({ valid: false, message: 'This promo code isn’t valid for this restaurant.' })
  }

  // (6) minimum subtotal — evaluated against the PRE-discount subtotal, universally
  // (previously the restaurant-funded branch returned before ever reaching this).
  const minSub = n(promo.min_order_subtotal)
  if (minSub != null && orderSubtotal < minSub) {
    return NextResponse.json({ valid: false, message: `Add $${minSub.toFixed(2)} more to use this code.` })
  }

  // (7) first-time-only — restaurant-scoped (countPriorPaidOrders), the same
  // definition the lead-gen fee tier uses, NOT the caller-supplied isFirstTimeUser
  // (which was platform-wide FM order history — a different, wrong question here).
  // Universal, same reason as (6).
  if (promo.first_time_only) {
    const ref = promo.restaurant_ref || restaurantRef
    const prior = userEmail ? await countPriorPaidOrders(userEmail, ref) : 0
    if (prior > 0) {
      return NextResponse.json({ valid: false, message: 'This promo code is for first-time customers only.' })
    }
  }

  // (8) per-user usage limit — universal, checked once (previously duplicated
  // between the restaurant-funded and DISCO-funded branches).
  if (userEmail) {
    const used = (await sql`SELECT COUNT(*)::int AS c FROM promo_code_uses WHERE promo_code_id = ${promo.id} AND LOWER(user_email) = ${userEmail}`) as { c: number }[]
    if ((used[0]?.c ?? 0) >= promo.max_uses_per_user) {
      return NextResponse.json({ valid: false, message: 'You’ve already used this promo code the maximum number of times.' })
    }
  }

  // (9) restaurant-funded codes discount the SUBTOTAL pre-charge (Path B): the
  // customer is charged the discounted total and the restaurant's transfer is
  // naturally smaller — no refund/reversal. Two prerequisites, both DIRECT-only:
  //  (1) the restaurant must be on FM moneyFlow=DIRECT — under FAMILY_MEAL, FM is
  //      the merchant of record and pays the restaurant out-of-band, so a discount
  //      would be absorbed by FamilyMeal, not the restaurant (PERMANENT constraint,
  //      Revyrie gone — restaurant-funded is DIRECT-only, full stop).
  //  (2) the restaurant's tax rates must be mirrored into Neon (FM exposes them only
  //      to the restaurant's own admin token) so checkout can recompute tax to the cent.
  if (promo.funded_by === 'RESTAURANT') {
    const ref = promo.restaurant_ref || restaurantRef
    const trows = (await sql`SELECT tax_rates, money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`) as { tax_rates: unknown; money_flow: string | null }[]
    if (trows[0]?.money_flow === 'FAMILY_MEAL') {
      return NextResponse.json({ valid: false, message: 'This promo code can’t be applied for this restaurant.' })
    }
    if (!trows[0]?.tax_rates) {
      return NextResponse.json({ valid: false, message: 'This promo code can’t be applied for this restaurant right now.' })
    }
    // max_uses re-checked here for an honest preview — the ACTUAL gate against a
    // double-submit or a second concurrent order is reserveNativeRestaurantPromoUse
    // (lib/promo-native.ts), called atomically right before the charge from BOTH
    // real placement paths: native (native-place-checkout.ts) and FM-backed
    // (lib/promo-apply.ts's applyRestaurantFundedDiscount). This read here can go
    // stale between validate and place; that's fine, placement never trusts it.
    if (promo.max_uses != null && promo.uses_count >= promo.max_uses) {
      return NextResponse.json({ valid: false, message: 'This promo code has reached its usage limit.' })
    }
    // Discount the SUBTOTAL (headline) — flat-$/percent-with-cap resolved to an
    // equivalent pct the exact same way placement will (resolveEffectiveDiscountPct),
    // so the preview number can't drift from what actually charges. The exact charge
    // reduction (tax/fee/tip also recompute off the discounted subtotal) is finalized
    // authoritatively at placement.
    const value = n(promo.discount_value) ?? 0
    const cap = n(promo.max_discount_cap)
    const effectivePct = resolveEffectiveDiscountPct(orderSubtotal, promo.discount_type, value, cap)
    const subtotalDiscount = r2(orderSubtotal * (effectivePct / 100))
    return NextResponse.json({
      valid: true,
      fundedBy: 'RESTAURANT',
      discountAmount: subtotalDiscount,
      discountType: promo.discount_type,
      discountValue: value,
      code: promo.code,
      message: promo.discount_type === 'flat'
        ? `Promo applied — $${value.toFixed(2)} off. Your discounted total is calculated at checkout.`
        : `Promo applied — ${value}% off. Your discounted total is calculated at checkout.`,
    })
  }

  // (10) DISCO-funded: knocks a flat amount off orderTotal at redemption time
  // (post-charge, /api/promo/redeem) — a different mechanism from restaurant-funded's
  // pre-charge subtotal recompute above, so it's intentionally not unified with
  // resolveEffectiveDiscountPct (that function is specifically for the subtotal-based
  // recompute pipeline).
  const value = n(promo.discount_value) ?? 0
  let discountAmount: number
  if (promo.discount_type === 'flat') {
    discountAmount = Math.min(value, orderTotal)
  } else {
    discountAmount = orderTotal * (value / 100)
    const cap = n(promo.max_discount_cap)
    if (cap != null) discountAmount = Math.min(discountAmount, cap)
    discountAmount = Math.min(discountAmount, orderTotal)
  }
  discountAmount = Math.max(0, Math.round(discountAmount * 100) / 100)

  return NextResponse.json({
    valid: true,
    fundedBy: 'DISCO',
    discountAmount,
    discountType: promo.discount_type,
    discountValue: value,
    code: promo.code,
    message: `Promo applied — you save $${discountAmount.toFixed(2)}.`,
  })
}
