import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { r2 } from '../../../../lib/promo-pricing'

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
// { code, restaurantRef, orderSubtotal, orderTotal, userEmail, isFirstTimeUser }
export async function POST(req: NextRequest) {
  await runMigrations()
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ valid: false, message: 'Invalid request.' }, { status: 400 }) }

  const code = String(body.code || '').trim()
  const restaurantRef = body.restaurantRef ? String(body.restaurantRef) : ''
  const orderSubtotal = n(body.orderSubtotal as number) ?? 0
  const orderTotal = n(body.orderTotal as number) ?? 0
  const userEmail = String(body.userEmail || '').trim().toLowerCase()
  const isFirstTimeUser = body.isFirstTimeUser === true

  if (!code) return NextResponse.json({ valid: false, message: 'Enter a promo code.' }, { status: 400 })

  // (1) code exists — 404 if not. Codes are now unique per (restaurant, code),
  // and the same code string can exist as a global code AND as different
  // restaurants' codes. Scope the lookup to this restaurant's own code or a
  // global one, preferring the restaurant-specific match.
  const rows = (await sql`
    SELECT * FROM promo_codes
    WHERE UPPER(code) = UPPER(${code})
      AND (restaurant_ref IS NULL OR restaurant_ref = ${restaurantRef})
    ORDER BY (restaurant_ref IS NOT NULL) DESC, id DESC
    LIMIT 1
  `) as PromoRow[]
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

  // (5b) restaurant-funded codes discount the SUBTOTAL pre-charge (Path B): the
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
    // Discount the SUBTOTAL (headline). The exact charge reduction (tax/fee/tip also
    // recompute off the discounted subtotal) is finalized authoritatively at placement.
    const value = n(promo.discount_value) ?? 0
    const subtotalDiscount = r2(orderSubtotal * (value / 100))
    return NextResponse.json({
      valid: true,
      fundedBy: 'RESTAURANT',
      discountAmount: subtotalDiscount,
      discountType: 'percent',
      discountValue: value,
      code: promo.code,
      message: `Promo applied — ${value}% off. Your discounted total is calculated at checkout.`,
    })
  }

  // (6) minimum subtotal
  const minSub = n(promo.min_order_subtotal)
  if (minSub != null && orderSubtotal < minSub) {
    return NextResponse.json({ valid: false, message: `Add $${minSub.toFixed(2)} more to use this code.` })
  }

  // (7) first-time-only
  if (promo.first_time_only && !isFirstTimeUser) {
    return NextResponse.json({ valid: false, message: 'This promo code is for first-time customers only.' })
  }

  // (8) per-user usage limit
  if (userEmail) {
    const used = (await sql`
      SELECT COUNT(*)::int AS c FROM promo_code_uses
      WHERE promo_code_id = ${promo.id} AND LOWER(user_email) = ${userEmail}
    `) as { c: number }[]
    if ((used[0]?.c ?? 0) >= promo.max_uses_per_user) {
      return NextResponse.json({ valid: false, message: 'You’ve already used this promo code.' })
    }
  }

  // Compute discount.
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
