// Per-menu money/timing settings (Stage 5): parse from the admin form for storage,
// and map a disco_menus row into the FM-shaped `settings` + `scheduleOption` the
// customer flow (pricer + availability engine) already consumes. Zero FM.

import { r2 } from './promo-pricing'

export interface MenuSettingsInput {
  offersPickup: boolean
  offersDelivery: boolean
  serviceChargePct: number
  serviceChargeName: string | null
  tipDefaultType: 'PERCENTAGE' | 'CUSTOM' | 'NONE'
  tipDefaultValue: number
  pickupOrderMinimum: number
  deliveryOrderMinimum: number
  maxOrdersPerDay: number | null
  leadTimeHours: number
  rollingAvailabilityDays: number
  dailyCutoffTime: string | null // 'HH:mm'
  hardCutoffDate: string | null  // 'yyyy-mm-dd'
  includeUtensils: boolean
}

const n = (v: unknown, d = 0): number => { const x = Number(v); return Number.isFinite(x) ? x : d }
const clampInt = (v: unknown, min: number, max: number, d: number): number => {
  const x = Math.trunc(Number(v)); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : d
}

// Normalize the admin form body into storable settings (safe defaults + clamping).
export function parseMenuSettingsInput(body: Record<string, unknown>): MenuSettingsInput {
  const tipType = String(body?.tipDefaultType || 'PERCENTAGE').toUpperCase()
  return {
    offersPickup: body?.offersPickup !== false,
    offersDelivery: body?.offersDelivery !== false,
    serviceChargePct: Math.max(0, n(body?.serviceChargePct)),
    serviceChargeName: String(body?.serviceChargeName || '').trim() || null,
    tipDefaultType: tipType === 'CUSTOM' ? 'CUSTOM' : tipType === 'NONE' ? 'NONE' : 'PERCENTAGE',
    tipDefaultValue: Math.max(0, n(body?.tipDefaultValue, 15)),
    pickupOrderMinimum: Math.max(0, n(body?.pickupOrderMinimum)),
    deliveryOrderMinimum: Math.max(0, n(body?.deliveryOrderMinimum)),
    maxOrdersPerDay: body?.maxOrdersPerDay == null || body?.maxOrdersPerDay === '' ? null : Math.max(0, clampInt(body?.maxOrdersPerDay, 0, 100000, 0)),
    leadTimeHours: clampInt(body?.leadTimeHours, 0, 24 * 90, 24),
    rollingAvailabilityDays: clampInt(body?.rollingAvailabilityDays, 1, 365, 90),
    dailyCutoffTime: String(body?.dailyCutoffTime || '').trim() || null,
    hardCutoffDate: String(body?.hardCutoffDate || '').trim() || null,
    includeUtensils: body?.includeUtensils === true,
  }
}

// ── Item fields (Stage 8) ────────────────────────────────────────────────────
export interface ItemFields {
  displayPrice: string | null
  minQuantity: number | null
  allowSpecialInstructions: boolean
  vegetarian: boolean
  containsNuts: boolean
  glutenFree: boolean
  vegan: boolean
  // Max Inventory Per Day — NULL = unlimited (default, existing behavior
  // unaffected). See lib/order/native-inventory.ts for enforcement.
  maxInventoryPerDay: number | null
}
export function parseItemFields(body: Record<string, unknown>): ItemFields {
  const mq = body?.minQuantity
  const mip = body?.maxInventoryPerDay
  return {
    displayPrice: String(body?.displayPrice || '').trim().slice(0, 120) || null,
    minQuantity: mq == null || mq === '' ? null : Math.max(1, Math.trunc(Number(mq)) || 1),
    allowSpecialInstructions: body?.allowedSpecialInstructions === true || body?.allowSpecialInstructions === true,
    vegetarian: body?.vegetarian === true,
    containsNuts: body?.containsNuts === true,
    glutenFree: body?.glutenFree === true,
    vegan: body?.vegan === true,
    maxInventoryPerDay: mip == null || mip === '' ? null : Math.max(1, Math.trunc(Number(mip)) || 1),
  }
}

// ── Skipped / blackout days (Stage 7) ────────────────────────────────────────
/**
 * A menu blackout. `intervals` EMPTY or absent = the whole date is blocked;
 * `intervals` present = only those hours are, and the rest of the day stays
 * orderable. Mirrors FM's own shape and its own rule (getMenuSkippedDates blocks
 * a DATE only when the skip has no intervals).
 *
 * The intervals field is ADDITIVE on a JSONB column, which is why this needed no
 * migration: every row written before it existed has no intervals, and "no
 * intervals" already meant "whole day" — so old rows carry their exact previous
 * meaning with no translation step. Unlike the delivery-fee split there is no
 * legacy shape to migrate on read.
 */
export interface SkippedInterval { fromTime: string; toTime: string }
export interface SkippedDay { name?: string; fromDate: string; toDate: string; intervals?: SkippedInterval[] }
const ISO = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
// Bounded so a malformed/hostile payload can't store an unbounded array in JSONB.
// FM's own data tops out at one interval per entry; 12 is generous headroom.
const MAX_INTERVALS = 12

/** Normalize a time to "HH:mm". Accepts FM's LocalTime "H:mm:ss" — note the
 *  SINGLE-DIGIT hour ("9:00:00", "0:45:00"), which a naive slice(0,5) turns into
 *  "0:45" and then fails HHMM validation. */
export function toHHMM(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  if (!Number.isFinite(h) || h > 23) return null
  const out = `${String(h).padStart(2, '0')}:${m[2]}`
  return HHMM.test(out) ? out : null
}

function parseIntervals(raw: unknown): SkippedInterval[] {
  if (!Array.isArray(raw)) return []
  const out: SkippedInterval[] = []
  for (const iv of raw.slice(0, MAX_INTERVALS)) {
    const o = iv as Record<string, unknown> | null
    const fromTime = toHHMM(o?.fromTime), toTime = toHHMM(o?.toTime)
    // A zero-width or inverted range would block nothing (or everything, depending
    // on the reader) — refuse it rather than store an ambiguous rule.
    if (!fromTime || !toTime || fromTime >= toTime) continue
    out.push({ fromTime, toTime })
  }
  return out
}

export function parseSkippedDays(body: Record<string, unknown>): SkippedDay[] {
  const raw = Array.isArray(body?.skippedDays) ? (body.skippedDays as Record<string, unknown>[]) : []
  return raw
    .map(d => {
      const intervals = parseIntervals(d?.intervals)
      return {
        name: (String(d?.name || '').trim().slice(0, 255)) || undefined,
        fromDate: String(d?.fromDate || ''),
        toDate: String(d?.toDate || d?.fromDate || ''),
        ...(intervals.length ? { intervals } : {}),
      }
    })
    .filter(d => ISO.test(d.fromDate) && ISO.test(d.toDate))
}

// ── Delivery settings (Stage 6) ──────────────────────────────────────────────
// LEGACY. Retained only so stored rows written before the two-component change
// can still be READ (see parseTier's migrate-on-read). Nothing writes it any more.
export type DeliveryFeeType = 'FIXED' | 'PERCENT'

/**
 * One self-delivery zone: a radius, and TWO INDEPENDENT fee components that ADD.
 *
 * This replaces a single `feeType: 'FIXED' | 'PERCENT'` + `feeValue` pair, which
 * could represent only one component and therefore could not represent FM's
 * model at all. FM stores six nullable BigDecimals per menu —
 * ownDeliveryFee/ownDeliveryFeePercent/ownDeliveryRadius and the secondary
 * triplet — and PriceCalculateService.calculateOwnDeliveryFee ADDS them:
 *
 *     getBigDecimalOrZero(ownDeliveryFee)
 *       .add(subtotal.multiply(ONE_PERCENT).multiply(getBigDecimalOrZero(ownDeliveryFeePercent)))
 *
 * with ONE_PERCENT = 0.01, applied to SUBTOTAL, then setScale(2, HALF_UP).
 *
 * The cost of not being able to represent it was real and measured: all four
 * Hugo's locations run "$20 + 10%"-style zones in FM, the faithful importer's
 * percent-wins precedence kept only the percentage, and order 900000094
 * collected $7.70 where FM would have collected $37.70.
 *
 * BOTH DEFAULT TO 0, deliberately: "neither set" then means free delivery, which
 * is exactly what FM's getBigDecimalOrZero does with two NULLs. A zone with a
 * radius and no fees is a real, valid configuration.
 */
export interface DeliveryTier { radiusMiles: number; feeFixed: number; feePercent: number }
// method OWN_DELIVERY: restaurant delivers with its own configurable radius/fee.
// method THIRD_PARTY: Disco dispatches a courier. The TOTAL fee is a fixed platform
// rule (15% of subtotal, capped at $85) that Disco always collects to pay the courier.
// thirdPartySubsidyPct (0–15) splits that fixed fee between the customer and the
// restaurant: the customer pays fee×(15−subsidy)/15, the restaurant covers the rest
// (deducted from its payout). Higher subsidy = cheaper delivery for the customer,
// funded by the restaurant; Disco stays neutral. Matches FM PriceCalculateService.
export interface DeliverySettings {
  method: 'OWN_DELIVERY' | 'THIRD_PARTY'
  own?: { primary?: DeliveryTier; secondary?: DeliveryTier }
  thirdPartySubsidyPct: number // 0–15 percentage points out of the 15% fee
}

/**
 * Read a zone, MIGRATING ON READ from the legacy single-component shape.
 *
 * delivery_settings is a JSONB blob with 45 live rows across 18 restaurants and
 * no migration runner touches its interior. A hard cutover to the new field
 * names would therefore read `feeFixed`/`feePercent` as undefined on every
 * existing row and zero every configured delivery fee the moment it deployed.
 * So legacy `feeType`/`feeValue` stays readable for one release: new fields win
 * when present, legacy is translated when they are not.
 *
 * Translation is lossless in the only direction that exists — a legacy row held
 * exactly one component, so it maps to that component plus a zero.
 */
function parseTier(t: unknown): DeliveryTier | undefined {
  const o = t as Record<string, unknown> | null
  if (!o || o.radiusMiles == null) return undefined
  const radiusMiles = Math.max(0, n(o.radiusMiles))

  if (o.feeFixed != null || o.feePercent != null) {
    return { radiusMiles, feeFixed: Math.max(0, n(o.feeFixed)), feePercent: Math.max(0, n(o.feePercent)) }
  }
  // Legacy shape.
  const isPercent = String(o.feeType || 'FIXED').toUpperCase() === 'PERCENT'
  const v = Math.max(0, n(o.feeValue))
  return { radiusMiles, feeFixed: isPercent ? 0 : v, feePercent: isPercent ? v : 0 }
}

// Normalize the admin form's delivery settings for storage. Null when absent.
export function parseDeliverySettings(body: Record<string, unknown>): DeliverySettings | null {
  const raw = body?.deliverySettings as Record<string, unknown> | undefined
  if (!raw) return null
  const method = String(raw.method || 'THIRD_PARTY').toUpperCase() === 'OWN_DELIVERY' ? 'OWN_DELIVERY' : 'THIRD_PARTY'
  const own = raw.own as Record<string, unknown> | undefined
  return {
    method,
    own: own ? { primary: parseTier(own.primary), secondary: parseTier(own.secondary) } : undefined,
    // 0–15 points out of the 15% fee; default 0 (no subsidy). We deliberately do NOT
    // replicate FM's "20 if cleared" default, which would make the customer fee negative.
    thirdPartySubsidyPct: Math.max(0, Math.min(THIRD_PARTY_DELIVERY_FEE_PCT, n(raw.thirdPartySubsidyPct))),
  }
}

const round2d = (x: number) => Math.round(x * 100) / 100
// FM's calculateOwnDeliveryFee, arithmetic for arithmetic: fixed + percent-of-
// subtotal, rounded once at the end (FM does setScale(2, HALF_UP) on the sum,
// not on the parts — rounding each component separately can differ by a cent).
function tierFee(t: DeliveryTier, subtotal: number): number {
  return round2d(t.feeFixed + subtotal * t.feePercent / 100)
}

// THIRD_PARTY delivery — the platform fee is a flat 15% of subtotal capped at $85.
export const THIRD_PARTY_DELIVERY_FEE_PCT = 15
export const THIRD_PARTY_DELIVERY_FEE_CAP = 85

export interface ThirdPartyDelivery {
  fullFee: number     // total delivery cost Disco collects to pay the courier (fixed)
  customerFee: number // what the customer pays  = fullFee × (15 − subsidy)/15
  subsidy: number     // what the restaurant covers = fullFee − customerFee (off its payout)
}

// Replicates FM's PriceCalculateService.calculateThirdPartyDeliveryFee +
// RestaurantSaleTransactionServiceImpl.calculateThirdPartyDeliverySubsiding exactly:
//   fullFee     = min(subtotal × 15%, $85)              (unrounded, capped)
//   customerFee = r2( fullFee × (15 − subsidyPct)/15 )  (HALF_UP, 2dp)
//   subsidy     = r2( fullFee − customerFee )
// The subsidy shifts cost from customer to restaurant; Disco always nets fullFee.
export function computeThirdPartyDelivery(subtotal: number, subsidyPct = 0): ThirdPartyDelivery {
  const s = Math.max(0, Math.min(THIRD_PARTY_DELIVERY_FEE_PCT, subsidyPct))
  const fullFee = Math.min(subtotal * THIRD_PARTY_DELIVERY_FEE_PCT / 100, THIRD_PARTY_DELIVERY_FEE_CAP)
  const customerFee = r2(fullFee * (THIRD_PARTY_DELIVERY_FEE_PCT - s) / THIRD_PARTY_DELIVERY_FEE_PCT)
  const subsidy = r2(fullFee - customerFee)
  return { fullFee: r2(fullFee), customerFee, subsidy }
}

// OWN_DELIVERY serviceability + fee for a distance: primary ring first, then the
// (optional) secondary ring, else out of range.
/**
 * OWN_DELIVERY serviceability + fee for a distance.
 *
 * DELIBERATELY STRICTER THAN FM, and this is a choice rather than an oversight.
 * FM's calculateOwnDeliveryFee applies the secondary zone's fee to ANY distance
 * past the primary radius — there is no upper bound in that function, so an
 * address 40 miles out is quoted the secondary fee and accepted. Disco returns
 * serviceable:false beyond the secondary radius instead.
 *
 * Kept because the radius is the restaurant's statement of how far it will
 * drive, and quoting a fee for a delivery nobody intends to make is worse than
 * refusing it: the customer pays, the restaurant discovers it cannot deliver,
 * and someone has to unwind a paid order. If FM parity is ever wanted here it
 * should be an explicit setting, not a silent widening.
 */
export function computeOwnDeliveryFee(own: DeliverySettings['own'], distanceMiles: number, subtotal: number): { serviceable: boolean; fee: number } {
  // parseTier, NOT the raw tiers. `own` arrives straight off disco_menus.delivery_settings
  // — a JSONB blob no migration runner rewrites — so a row written before the
  // two-component change still carries feeType/feeValue and has no feeFixed/feePercent
  // at all. Reading those raw made tierFee compute `undefined + subtotal * undefined/100`
  // = NaN, which propagated to the order total, serialized to JSON as null (hiding the
  // delivery-fee line and undercounting the customer's total), and reached Stripe as
  // `amount: NaN` → "Invalid integer: NaN". Every own-delivery checkout at the 13
  // restaurants still on the legacy shape failed this way, 5 attempts / 2 lost orders
  // between the 2026-08-25 deploy and 2026-08-27. parseTier is the same migrate-on-read
  // the write path has always used; it belongs on BOTH sides of the blob.
  const primary = parseTier(own?.primary)
  const secondary = parseTier(own?.secondary)
  if (primary && distanceMiles <= primary.radiusMiles) return { serviceable: true, fee: tierFee(primary, subtotal) }
  if (secondary && distanceMiles <= secondary.radiusMiles) return { serviceable: true, fee: tierFee(secondary, subtotal) }
  return { serviceable: false, fee: 0 }
}

// The disco_menus columns as read back (snake_case).
export interface MenuSettingsRow {
  delivery_settings?: DeliverySettings | null
  offers_pickup?: boolean
  offers_delivery?: boolean
  service_charge_pct?: string | number | null
  service_charge_name?: string | null
  tip_default_type?: string | null
  tip_default_value?: string | number | null
  pickup_order_minimum?: string | number | null
  delivery_order_minimum?: string | number | null
  max_orders_per_day?: number | null
  lead_time_hours?: number | null
  rolling_availability_days?: number | null
  daily_cutoff_time?: string | null
  hard_cutoff_date?: string | null
}

// FM-shaped `settings` the client pricer/min-order gate read.
export function menuRowToSettings(row: MenuSettingsRow) {
  const menuAvailability: string[] = []
  if (row.offers_pickup !== false) menuAvailability.push('PICKUP')
  if (row.offers_delivery !== false) menuAvailability.push('DELIVERY')
  const tipType = String(row.tip_default_type || 'PERCENTAGE').toUpperCase()
  const del = row.delivery_settings || undefined
  // parseTier for the same reason computeOwnDeliveryFee needs it: this row came out
  // of the JSONB blob unnormalized. Reading `primary.feeFixed` raw off a legacy row
  // yielded undefined, so feeCurrency() returned null and every surface fed by these
  // FM-shaped settings showed a configured $25 fee as "not set".
  const primary = parseTier(del?.own?.primary)
  const secondary = parseTier(del?.own?.secondary)
  // Both components surface independently now; a zero reads as "not set" for
  // display purposes, matching how FM renders an empty box rather than a 0.
  const feeCurrency = (t?: DeliveryTier) => t && t.feeFixed > 0 ? t.feeFixed : null
  const feePercent = (t?: DeliveryTier) => t && t.feePercent > 0 ? t.feePercent : null
  return {
    menuAvailability: menuAvailability.length ? menuAvailability : ['PICKUP', 'DELIVERY'],
    // Whether fulfillment is worth surfacing in the customer notices bar. The menu
    // save ALWAYS persists offers_pickup/offers_delivery (defaulting BOTH true), so
    // a null-check can't tell "chose both" from "never configured". Treat "both
    // offered" as the default (don't advertise "Pickup & Delivery" as if it were a
    // deliberate constraint); surface it only when the restaurant RESTRICTED to one.
    menuAvailabilityExplicit: row.offers_pickup === false || row.offers_delivery === false,
    serviceCharge: n(row.service_charge_pct),
    serviceChargeName: row.service_charge_name || null,
    ...(tipType === 'NONE' ? {} : { tipOption: { tipsPrice: n(row.tip_default_value, 15), tipsType: tipType === 'CUSTOM' ? 'CUSTOM' : 'PERCENTAGE' } }),
    pickupOrderMinimum: n(row.pickup_order_minimum),
    deliveryOrderMinimum: n(row.delivery_order_minimum),
    // Delivery (FM-shaped) — drives the customer delivery UI + fee display.
    deliveryType: del?.method === 'OWN_DELIVERY' ? 'OWN_DELIVERY' : 'NASH_DELIVERY',
    ownDeliveryRadius: primary?.radiusMiles ?? null,
    ownDeliveryFee: feeCurrency(primary),
    ownDeliveryFeePercent: feePercent(primary),
    secondaryOwnDeliveryRadius: secondary?.radiusMiles ?? null,
    secondaryOwnDeliveryFee: feeCurrency(secondary),
    secondaryOwnDeliveryFeePercent: feePercent(secondary),
    // Third-party subsidy % (0–15): shifts the fixed 15%/$85 fee from the customer to
    // the restaurant. The actual dollar split is computed at order time.
    thirdPartyDeliverySubsidingPercent: del?.thirdPartySubsidyPct ?? 0,
  }
}

// Timing fields merged into the scheduleOption the availability engine reads.
export function menuRowToScheduleExtras(row: MenuSettingsRow) {
  return {
    prepTime: row.lead_time_hours != null ? Number(row.lead_time_hours) : 24,
    // Gates the "Nhr lead time" line in the customer notices bar. The menu save
    // ALWAYS persists lead_time_hours (defaulting to 24), so a null-check can't
    // detect "never configured". Surface the line only when the restaurant set a
    // NON-default lead time; the ubiquitous 24h default is treated as noise.
    prepTimeExplicit: row.lead_time_hours != null && Number(row.lead_time_hours) !== 24,
    rollingAvailability: row.rolling_availability_days != null ? Number(row.rolling_availability_days) : 90,
    ...(row.daily_cutoff_time ? { cutOff: row.daily_cutoff_time } : {}),
    ...(row.hard_cutoff_date ? { cutOffDate: row.hard_cutoff_date } : {}),
    ...(row.max_orders_per_day != null ? { maxOrder: row.max_orders_per_day } : {}),
  }
}

// The service-charge % a native order should use, read from its restaurant's
// primary (lowest-position, visible) menu. 0 when none.
export function primaryMenuServiceChargePct(row: MenuSettingsRow | undefined): number {
  return row ? n(row.service_charge_pct) : 0
}
