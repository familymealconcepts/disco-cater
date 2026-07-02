import type Stripe from 'stripe'
import { sql } from './db'
import { computeBreakdown, deriveLeadGenPct, r2, cents, type PricingConfig, type PricingOrder } from './promo-pricing'

// Applies a restaurant-funded promo discount PRE-CHARGE (Path B): recompute FM's
// discounted total + restaurant transfer and adjust the FM-created PaymentIntent's
// amount (+ transfer_data.amount under DIRECT). No refund/reversal/webhook/cron.
//
// SAFETY: before adjusting anything, we reproduce FM's FULL-price total (and, for
// DIRECT, transfer) from our engine and require an EXACT cent match against the
// real PI. Only then do we trust the discounted recompute. Any mismatch, missing
// tax mirror, or non-percentage tip config → we DO NOT apply the discount and
// return a reason, so the customer is never charged a wrong amount.

const num = (v: unknown): number => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

export interface ApplyResult {
  applied: boolean
  reason?: string
  discountPct?: number
  subtotalDiscount?: number      // headline subtotal reduction (for receipts)
  newAmount?: number             // charged total, dollars
  newTransfer?: number | null    // restaurant payout, dollars (null = FAMILY_MEAL)
  moneyFlow?: 'DIRECT' | 'FAMILY_MEAL'
}

interface TaxRatesMirror {
  stateSalesTax?: { percent?: number; fixedAmount?: number }
  localSalesTax?: { percent?: number; fixedAmount?: number }
  otherSalesTax?: { percent?: number; fixedAmount?: number; types?: string[] }
}

// Look up + basic-validate the restaurant-funded code (authoritative discount %).
async function resolveCode(code: string, restaurantRef: string): Promise<{ id: number; pct: number } | null> {
  const rows = (await sql`
    SELECT id, discount_value, valid_from, valid_until, active, max_uses, uses_count
    FROM promo_codes
    WHERE UPPER(code) = UPPER(${code}) AND funded_by = 'RESTAURANT' AND restaurant_ref = ${restaurantRef}
    ORDER BY id DESC LIMIT 1
  `) as { id: number; discount_value: string | number; valid_from: string | null; valid_until: string | null; active: boolean; max_uses: number | null; uses_count: number }[]
  const p = rows[0]
  if (!p || !p.active) return null
  const now = Date.now()
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return null
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return null
  if (p.max_uses != null && p.uses_count >= p.max_uses) return null
  const pct = num(p.discount_value)
  if (!(pct >= 1 && pct <= 100)) return null
  return { id: p.id, pct }
}

export async function applyRestaurantFundedDiscount(args: {
  stripe: Stripe
  paymentIntentId: string
  restaurantRef: string
  code: string
  serviceChargePct: number         // from the order's menu settings (client-supplied; self-check validates it)
  orderType: string                // 'PICKUP' | 'DELIVERY' (for otherTax.types gate)
  fmCheckout: Record<string, unknown>  // FM's full-price CheckoutPublicResponseDto
  orderRef: string                 // for recording the use (usage-limit enforcement) idempotently
  userEmail: string
}): Promise<ApplyResult> {
  const { stripe, paymentIntentId, restaurantRef, code, serviceChargePct, orderType, fmCheckout, orderRef, userEmail } = args
  if (!paymentIntentId) return { applied: false, reason: 'no payment intent' }

  const resolved = await resolveCode(code, restaurantRef)
  if (!resolved) return { applied: false, reason: 'code invalid/expired/inactive' }

  // Tax rates from the Neon mirror (only source at customer-checkout time).
  const mrows = (await sql`SELECT tax_rates FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantRef} LIMIT 1`) as { tax_rates: TaxRatesMirror | null }[]
  const tax = mrows[0]?.tax_rates
  if (!tax) return { applied: false, reason: 'tax rates not mirrored for restaurant' }

  // FM full-price components.
  const subtotal = num(fmCheckout.subtotal)
  if (subtotal <= 0) return { applied: false, reason: 'no subtotal' }
  const fullServiceCharge = num(fmCheckout.serviceCharge)
  const fullStateTax = num(fmCheckout.stateSalesTaxInPrice)
  const fullLocalTax = num(fmCheckout.localSalesTaxInPrice)
  const fullOtherTax = num(fmCheckout.otherSalesTaxInPrice)
  const ownDeliveryFee = num(fmCheckout.ownDeliveryFee)
  const thirdPartyDeliveryFee = num(fmCheckout.thirdPartyDeliveryFee)
  const fullTipsInPrice = num(fmCheckout.tipsInPrice)
  const fullThirdPartyTips = num(fmCheckout.thirdPartyDeliveryTipsInPrice)
  const subsidy = num(fmCheckout.thirdPartyDeliverySubsiding)
  const tipsAreThirdParty = fullThirdPartyTips > 0

  // Recover the customer's tip config from FM's full-price tip (tip base = subtotal
  // at full price, so tipPct = fullTip/subtotal×100). Custom tips can't be scaled
  // by the discount, so if we can't cleanly recover a % we treat it as custom
  // (unchanged) — the self-check will still verify the full total matches.
  const tipVal = tipsAreThirdParty ? fullThirdPartyTips : fullTipsInPrice
  const tipPctRaw = subtotal > 0 ? (tipVal / subtotal) * 100 : 0
  const tipPct = Math.round(tipPctRaw * 100) / 100
  const tipLooksPercentage = tipVal > 0 && Math.abs(r2(subtotal * tipPct / 100) - tipVal) < 0.005
  const tipCustom = !tipLooksPercentage

  const other = tax.otherSalesTax
  const otherApplies = !!other && (!other.types || other.types.length === 0 || other.types.includes(orderType))

  // Retrieve the authoritative PI (amount + transfer_data for DIRECT).
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
  const piAmount = pi.amount ?? 0
  const piTransfer = pi.transfer_data?.amount
  const moneyFlow: 'DIRECT' | 'FAMILY_MEAL' = piTransfer != null ? 'DIRECT' : 'FAMILY_MEAL'

  const order: PricingOrder = {
    subtotal, ownDeliveryFee, thirdPartyDeliveryFee, thirdPartyDeliverySubsiding: subsidy,
    tipCustom, tipAmount: tipVal, tipPct, tipsAreThirdParty,
  }

  // Derive the applied lead-gen % from FM's real full transfer (DIRECT only).
  let leadGenPct = 0
  if (moneyFlow === 'DIRECT') {
    const fullTotalForStripe = piAmount / 100
    const fullStripeFee = r2(fullTotalForStripe * 2.9 / 100 + 0.30)
    leadGenPct = deriveLeadGenPct({
      subtotal, fullTipsInPrice, fullStateTax, fullLocalTax, fullOtherTax,
      ownDeliveryFee, fullServiceCharge, thirdPartyDeliverySubsiding: subsidy,
      fullStripeFee, actualFullTransfer: piTransfer! / 100,
    })
  }

  const cfg: PricingConfig = {
    scPct: serviceChargePct,
    stateTax: { percent: num(tax.stateSalesTax?.percent), fixedAmount: num(tax.stateSalesTax?.fixedAmount) },
    localTax: { percent: num(tax.localSalesTax?.percent), fixedAmount: num(tax.localSalesTax?.fixedAmount) },
    otherTax: { percent: num(other?.percent), fixedAmount: num(other?.fixedAmount), applies: otherApplies },
    familyMealPct: 3, stripePct: 2.9, stripeFlat: 0.30, leadGenPct,
  }

  // ── SELF-CHECK: reproduce FM's FULL-price numbers exactly, or bail. ──
  const full = computeBreakdown(order, cfg, 0)
  if (cents(full.total) !== piAmount) {
    return { applied: false, reason: `self-check total mismatch: ours=${cents(full.total)}c fm=${piAmount}c` }
  }
  if (moneyFlow === 'DIRECT' && cents(full.transfer) !== piTransfer) {
    return { applied: false, reason: `self-check transfer mismatch: ours=${cents(full.transfer)}c fm=${piTransfer}c` }
  }

  // Self-check passed → the discounted recompute is trustworthy.
  const disc = computeBreakdown(order, cfg, resolved.pct)
  const newAmount = cents(disc.total)
  const newTransfer = moneyFlow === 'DIRECT' ? cents(disc.transfer) : null
  if (newAmount <= 0 || newAmount >= piAmount) return { applied: false, reason: 'discount produced no reduction' }
  if (newTransfer != null && (newTransfer <= 0 || newTransfer >= piTransfer!)) return { applied: false, reason: 'transfer reduction invalid' }

  await stripe.paymentIntents.update(paymentIntentId, {
    amount: newAmount,
    ...(newTransfer != null ? { transfer_data: { amount: newTransfer } } : {}),
  })

  // Record the use + increment the counter (usage-limit enforcement), idempotent
  // per order so a retry can't double-count. No refund/reversal bookkeeping — the
  // discount is fully settled in the charge itself.
  try {
    const existing = (await sql`SELECT 1 FROM promo_code_uses WHERE promo_code_id = ${resolved.id} AND order_ref = ${orderRef} LIMIT 1`) as unknown[]
    if (!existing.length) {
      await sql`
        INSERT INTO promo_code_uses (promo_code_id, user_email, order_ref, discount_applied, refund_status, funded_by, restaurant_ref, stripe_payment_intent_id)
        VALUES (${resolved.id}, ${userEmail || ''}, ${orderRef}, ${disc.discount}, 'not_applicable', 'RESTAURANT', ${restaurantRef}, ${paymentIntentId})
      `
      await sql`UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ${resolved.id}`
    }
  } catch (e) {
    console.error('[promo-apply] use recording failed (charge already discounted):', e instanceof Error ? e.message : e)
  }

  return {
    applied: true,
    discountPct: resolved.pct,
    subtotalDiscount: disc.discount,
    newAmount: newAmount / 100,
    newTransfer: newTransfer != null ? newTransfer / 100 : null,
    moneyFlow,
  }
}
