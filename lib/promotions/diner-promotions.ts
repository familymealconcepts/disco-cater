// Diner promotions (Peter, 2026-11-18). The first type is "Free delivery on your next order from
// [restaurant]":
//
//   OFFERED    a Super Admin gave it to one diner account (Super Admin → Promotions)
//   ACTIVATED  the diner pressed Activate (Account → Promotions, the home card, or the email link)
//   USED       the diner's next third-party delivery order at that restaurant took it: the delivery
//              fee was set to $0 at checkout (lib/order/native-checkout.ts priceNativeCart)
//   CANCELLED  a Super Admin cancelled it before it was used
//   EXPIRED    not stored: an OFFERED or ACTIVATED promotion past expires_at reads as Expired, so it
//              can never fail to expire, and can't be activated or used
//
// DISCO FUNDS IT (Peter approved Disco paying the courier on these orders). The restaurant's payout
// is exactly what it would have been with the fee charged (promo-pricing.ts discoWaivedDeliveryFee),
// Disco still pays Expedite, and the waived fee is recorded on the sale transaction as
// disco_promo_delivery_waived so reports show it as a Disco-funded promotion.
//
// One use. It is taken when the order is placed (reserveForOrder) and goes back to ACTIVATED
// (releaseForOrder) when that order doesn't go through: placement fails, the checkout is abandoned
// (RESERVED expiry sweep), the order is cancelled before its scheduled delivery time, or an edit
// switches it off third-party delivery. A promotion released after its expiry reads as Expired.
import { sql } from '../db'
import { logAdminAction } from '../admin-audit'
import { sendEmail } from '../email/send'
import { layout, button } from '../email/layout'

export const PROMOTION_TYPES = ['FREE_DELIVERY'] as const
export type PromotionType = (typeof PROMOTION_TYPES)[number]
export type StoredPromotionStatus = 'OFFERED' | 'ACTIVATED' | 'USED' | 'CANCELLED'
export type PromotionStatus = StoredPromotionStatus | 'EXPIRED'
export const PROMOTION_STATUSES: PromotionStatus[] = ['OFFERED', 'ACTIVATED', 'USED', 'EXPIRED', 'CANCELLED']
export const STATUS_LABEL: Record<PromotionStatus, string> = {
  OFFERED: 'Offered', ACTIVATED: 'Activated', USED: 'Used', EXPIRED: 'Expired', CANCELLED: 'Cancelled',
}
export const DEFAULT_EXPIRY_DAYS = 60
/** Expiry dates are whole days in Eastern time: a promotion expiring "Jan 17" works all of Jan 17. */
export const PROMOTION_TZ = 'America/New_York'
const SITE_URL = 'https://www.discocater.com'

export interface DinerPromotion {
  id: number
  reference: string
  type: PromotionType
  status: PromotionStatus
  customerId: number
  customerEmail: string
  customerName: string
  restaurantReference: string
  restaurantName: string
  restaurantSlug: string | null
  restaurantImage: string | null
  restaurantCity: string | null
  restaurantState: string | null
  /** YYYY-MM-DD, the last day it can be used (Eastern). */
  expiresOn: string
  note: string | null
  createdBy: string | null
  createdAt: string
  emailedAt: string | null
  activatedAt: string | null
  usedAt: string | null
  orderReference: string | null
  orderNumber: number | null
  waivedAmount: number | null
  cancelledAt: string | null
  cancelledBy: string | null
}

/** The status a person sees: unused and past its expiry → EXPIRED. */
export function effectiveStatus(stored: StoredPromotionStatus, expiresAt: Date | string, now: Date = new Date()): PromotionStatus {
  if ((stored === 'OFFERED' || stored === 'ACTIVATED') && new Date(expiresAt).getTime() <= now.getTime()) return 'EXPIRED'
  return stored
}

/** Today in Eastern time as YYYY-MM-DD. */
export function todayEastern(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: PROMOTION_TZ })
}

/** The default expiry date: today (Eastern) + 60 days. */
export function defaultExpiresOn(now: Date = new Date()): string {
  const [y, m, d] = todayEastern(now).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + DEFAULT_EXPIRY_DAYS))
  return t.toISOString().slice(0, 10)
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// SELECT list shared by every read, so the admin list, the diner page and the checkout lookup cannot
// describe one promotion differently. expires_at is midnight Eastern at the START of the day after the
// last usable day, so the last usable day is that instant minus one second, in Eastern.
const SELECT_COLUMNS = `
  p.id, p.reference::text AS reference, p.promotion_type, p.status, p.expires_at,
  to_char((p.expires_at AT TIME ZONE '${PROMOTION_TZ}') - INTERVAL '1 second', 'YYYY-MM-DD') AS expires_on,
  p.customer_id, p.customer_email,
  trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) AS customer_name,
  p.restaurant_reference::text AS restaurant_reference,
  coalesce(rc.name, 'Restaurant') AS restaurant_name, rc.slug AS restaurant_slug, rc.image_url AS restaurant_image,
  rc.city AS restaurant_city, rc.state AS restaurant_state,
  p.note, p.created_by, p.created_at, p.emailed_at, p.activated_at, p.used_at,
  p.order_reference::text AS order_reference, p.order_number, p.waived_amount, p.cancelled_at, p.cancelled_by`
const FROM = `
  FROM disco_diner_promotions p
  LEFT JOIN disco_customers c ON c.id = p.customer_id
  LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = p.restaurant_reference::text`

type Row = Record<string, unknown>
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())
function toPromotion(r: Row, now: Date = new Date()): DinerPromotion {
  return {
    id: Number(r.id),
    reference: String(r.reference),
    type: String(r.promotion_type) as PromotionType,
    status: effectiveStatus(String(r.status) as StoredPromotionStatus, r.expires_at as string, now),
    customerId: Number(r.customer_id),
    customerEmail: String(r.customer_email),
    customerName: String(r.customer_name || ''),
    restaurantReference: String(r.restaurant_reference),
    restaurantName: String(r.restaurant_name),
    restaurantSlug: (r.restaurant_slug as string) || null,
    restaurantImage: (r.restaurant_image as string) || null,
    restaurantCity: (r.restaurant_city as string) || null,
    restaurantState: (r.restaurant_state as string) || null,
    expiresOn: String(r.expires_on),
    note: (r.note as string) || null,
    createdBy: (r.created_by as string) || null,
    createdAt: iso(r.created_at) as string,
    emailedAt: iso(r.emailed_at),
    activatedAt: iso(r.activated_at),
    usedAt: iso(r.used_at),
    orderReference: (r.order_reference as string) || null,
    orderNumber: r.order_number == null ? null : Number(r.order_number),
    waivedAmount: r.waived_amount == null ? null : Number(r.waived_amount),
    cancelledAt: iso(r.cancelled_at),
    cancelledBy: (r.cancelled_by as string) || null,
  }
}

// ── Who and where ──────────────────────────────────────────────────────────────

/**
 * Restaurants a free-delivery promotion can be given for: Disco-native, not archived, with an
 * active menu that offers delivery by courier (third-party). The same reading checkout uses
 * (loadMenuIsThirdPartyDelivery: anything not OWN_DELIVERY is third-party).
 */
const ELIGIBLE_RESTAURANT_SQL = `
  rc.is_disco_native = true
  AND NOT EXISTS (SELECT 1 FROM disco_restaurant_overrides ov WHERE ov.restaurant_reference = rc.restaurant_reference AND ov.archived_at IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM disco_menus m
    WHERE m.restaurant_reference::text = rc.restaurant_reference
      AND m.visible = true AND m.archived = false
      AND m.offers_delivery IS DISTINCT FROM false
      AND upper(coalesce(m.delivery_settings->>'method', '')) <> 'OWN_DELIVERY'
  )`

export async function searchEligibleRestaurants(q: string, limit = 20): Promise<{ reference: string; name: string; city: string | null; state: string | null }[]> {
  const like = `%${q.trim()}%`
  const rows = (await sql.query(
    `SELECT rc.restaurant_reference AS reference, rc.name, rc.city, rc.state
       FROM disco_restaurant_cache rc
      WHERE ${ELIGIBLE_RESTAURANT_SQL} AND rc.name ILIKE $1
      ORDER BY rc.name LIMIT $2`, [like, limit],
  )) as { reference: string; name: string; city: string | null; state: string | null }[]
  return rows
}

export async function isEligibleRestaurant(ref: string): Promise<boolean> {
  const rows = (await sql.query(
    `SELECT 1 FROM disco_restaurant_cache rc WHERE rc.restaurant_reference = $1 AND ${ELIGIBLE_RESTAURANT_SQL} LIMIT 1`, [ref],
  )) as unknown[]
  return rows.length > 0
}

export async function searchDiners(q: string, limit = 20): Promise<{ id: number; email: string; name: string }[]> {
  const like = `%${q.trim()}%`
  const rows = (await sql`
    SELECT id, email, trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name
      FROM disco_customers
     WHERE disabled_at IS NULL
       AND (email ILIKE ${like} OR (coalesce(first_name, '') || ' ' || coalesce(last_name, '')) ILIKE ${like})
     ORDER BY email LIMIT ${limit}
  `) as { id: number; email: string; name: string }[]
  return rows.map((r) => ({ id: Number(r.id), email: r.email, name: r.name }))
}

async function customerIdForEmail(email: string): Promise<number | null> {
  if (!email) return null
  const rows = (await sql`SELECT id FROM disco_customers WHERE lower(email) = lower(${email}) AND disabled_at IS NULL LIMIT 1`) as { id: number }[]
  return rows[0] ? Number(rows[0].id) : null
}

// ── Super Admin ────────────────────────────────────────────────────────────────

export interface CreatePromotionInput {
  customerId: number
  restaurantReference: string
  type?: PromotionType
  /** YYYY-MM-DD, last usable day (Eastern). Default: today + 60. */
  expiresOn?: string | null
  note?: string | null
  emailDiner: boolean
  createdBy: string | null
}

export type CreatePromotionResult = { ok: true; promotion: DinerPromotion; emailed: boolean } | { ok: false; status: number; error: string }

export async function createPromotion(input: CreatePromotionInput): Promise<CreatePromotionResult> {
  const type = input.type ?? 'FREE_DELIVERY'
  if (!PROMOTION_TYPES.includes(type)) return { ok: false, status: 400, error: 'Unknown promotion type.' }
  const expiresOn = (input.expiresOn || '').trim() || defaultExpiresOn()
  if (!DATE_RE.test(expiresOn)) return { ok: false, status: 400, error: 'Expiry must be a date.' }
  if (expiresOn < todayEastern()) return { ok: false, status: 400, error: 'The expiry date has already passed.' }
  const note = input.note?.trim() ? input.note.trim().slice(0, 1000) : null

  const cust = (await sql`SELECT id, email, first_name FROM disco_customers WHERE id = ${input.customerId} AND disabled_at IS NULL LIMIT 1`) as { id: number; email: string; first_name: string | null }[]
  if (!cust[0]) return { ok: false, status: 404, error: 'That diner account was not found.' }
  if (!(await isEligibleRestaurant(input.restaurantReference))) {
    return { ok: false, status: 400, error: 'Free delivery can only be given for a restaurant with a third-party delivery menu.' }
  }
  // One open free-delivery promotion per diner per restaurant (rule 5): an unexpired OFFERED or
  // ACTIVATED one already covers the next order there.
  const open = (await sql`
    SELECT 1 FROM disco_diner_promotions
     WHERE customer_id = ${input.customerId} AND restaurant_reference = ${input.restaurantReference}::uuid
       AND promotion_type = ${type} AND status IN ('OFFERED', 'ACTIVATED') AND expires_at > NOW()
     LIMIT 1
  `) as unknown[]
  if (open.length) return { ok: false, status: 409, error: 'This diner already has an open free-delivery promotion for this restaurant.' }

  const ins = (await sql`
    INSERT INTO disco_diner_promotions (promotion_type, customer_id, customer_email, restaurant_reference, expires_at, note, created_by)
    VALUES (${type}, ${input.customerId}, ${cust[0].email}, ${input.restaurantReference}::uuid,
            ((${expiresOn}::date + 1)::timestamp AT TIME ZONE ${PROMOTION_TZ}), ${note}, ${input.createdBy})
    RETURNING id
  `) as { id: number }[]
  const id = Number(ins[0].id)
  await logAdminAction({
    action: 'diner_promotion_create', restaurantReference: input.restaurantReference, actorEmail: input.createdBy,
    detail: { promotionId: id, type, customerId: input.customerId, customerEmail: cust[0].email, expiresOn, note, emailDiner: input.emailDiner },
  })

  let emailed = false
  let promotion = (await getPromotionById(id))!
  if (input.emailDiner) {
    const res = await sendFreeDeliveryPromotionEmail(promotion, cust[0].first_name || undefined)
    if (res.success) {
      await sql`UPDATE disco_diner_promotions SET emailed_at = NOW(), updated_at = NOW() WHERE id = ${id}`
      emailed = true
      promotion = (await getPromotionById(id))!
    }
  }
  return { ok: true, promotion, emailed }
}

export async function getPromotionById(id: number): Promise<DinerPromotion | null> {
  const rows = (await sql.query(`SELECT ${SELECT_COLUMNS} ${FROM} WHERE p.id = $1 LIMIT 1`, [id])) as Row[]
  return rows[0] ? toPromotion(rows[0]) : null
}

export interface PromotionFilters { diner?: string; restaurant?: string; status?: PromotionStatus | ''; createdBy?: string }

export async function listPromotions(f: PromotionFilters = {}): Promise<DinerPromotion[]> {
  const where: string[] = []
  const args: unknown[] = []
  // Each clause names its own argument number; a clause may use it more than once.
  const arg = (v: unknown) => { args.push(v); return `$${args.length}` }
  if (f.diner?.trim()) { const a = arg(`%${f.diner.trim()}%`); where.push(`(p.customer_email ILIKE ${a} OR (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) ILIKE ${a})`) }
  if (f.restaurant?.trim()) { const a = arg(`%${f.restaurant.trim()}%`); where.push(`coalesce(rc.name, '') ILIKE ${a}`) }
  if (f.createdBy?.trim()) { const a = arg(`%${f.createdBy.trim()}%`); where.push(`coalesce(p.created_by, '') ILIKE ${a}`) }
  if (f.status === 'EXPIRED') where.push(`p.status IN ('OFFERED', 'ACTIVATED') AND p.expires_at <= NOW()`)
  else if (f.status === 'OFFERED' || f.status === 'ACTIVATED') where.push(`p.status = ${arg(f.status)} AND p.expires_at > NOW()`)
  else if (f.status === 'USED' || f.status === 'CANCELLED') where.push(`p.status = ${arg(f.status)}`)
  const rows = (await sql.query(
    `SELECT ${SELECT_COLUMNS} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT 500`, args,
  )) as Row[]
  const now = new Date()
  return rows.map((r) => toPromotion(r, now))
}

export async function cancelPromotion(reference: string, by: string | null): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const rows = (await sql`
    UPDATE disco_diner_promotions SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ${by}, updated_at = NOW()
     WHERE reference = ${reference}::uuid AND status IN ('OFFERED', 'ACTIVATED')
    RETURNING id, restaurant_reference::text AS restaurant_reference, customer_email
  `) as { id: number; restaurant_reference: string; customer_email: string }[]
  if (!rows[0]) return { ok: false, status: 409, error: 'Only an unused promotion can be cancelled.' }
  await logAdminAction({
    action: 'diner_promotion_cancel', restaurantReference: rows[0].restaurant_reference, actorEmail: by,
    detail: { promotionId: Number(rows[0].id), customerEmail: rows[0].customer_email },
  })
  return { ok: true }
}

// ── Diner ──────────────────────────────────────────────────────────────────────

export async function listForDiner(email: string): Promise<DinerPromotion[]> {
  const id = await customerIdForEmail(email)
  if (id == null) return []
  const rows = (await sql.query(`SELECT ${SELECT_COLUMNS} ${FROM} WHERE p.customer_id = $1 ORDER BY p.created_at DESC`, [id])) as Row[]
  const now = new Date()
  return rows.map((r) => toPromotion(r, now))
}

export async function activateForDiner(email: string, reference: string): Promise<{ ok: true; promotion: DinerPromotion } | { ok: false; status: number; error: string }> {
  const id = await customerIdForEmail(email)
  if (id == null) return { ok: false, status: 401, error: 'Please sign in.' }
  const rows = (await sql`
    UPDATE disco_diner_promotions SET status = 'ACTIVATED', activated_at = NOW(), updated_at = NOW()
     WHERE reference = ${reference}::uuid AND customer_id = ${id} AND status = 'OFFERED' AND expires_at > NOW()
    RETURNING id
  `) as { id: number }[]
  const pid = rows[0] ? Number(rows[0].id) : null
  if (pid != null) return { ok: true, promotion: (await getPromotionById(pid))! }
  // Not activated now: already activated (fine), or not theirs, expired, used or cancelled.
  const cur = (await sql.query(`SELECT ${SELECT_COLUMNS} ${FROM} WHERE p.reference = $1::uuid AND p.customer_id = $2 LIMIT 1`, [reference, id])) as Row[]
  if (!cur[0]) return { ok: false, status: 404, error: 'Promotion not found.' }
  const p = toPromotion(cur[0])
  if (p.status === 'ACTIVATED') return { ok: true, promotion: p }
  return { ok: false, status: 409, error: p.status === 'EXPIRED' ? 'This promotion has expired.' : p.status === 'USED' ? 'This promotion has already been used.' : 'This promotion is no longer available.' }
}

// ── Checkout ───────────────────────────────────────────────────────────────────

/** The diner's activated, unexpired free-delivery promotion for this restaurant, if any. */
export async function findActivatedFreeDelivery(email: string, restaurantReference: string): Promise<{ id: number; reference: string } | null> {
  try {
    const id = await customerIdForEmail(email)
    if (id == null || !restaurantReference) return null
    const rows = (await sql`
      SELECT id, reference::text AS reference FROM disco_diner_promotions
       WHERE customer_id = ${id} AND restaurant_reference = ${restaurantReference}::uuid
         AND promotion_type = 'FREE_DELIVERY' AND status = 'ACTIVATED' AND expires_at > NOW()
       ORDER BY expires_at ASC LIMIT 1
    `) as { id: number; reference: string }[]
    return rows[0] ? { id: Number(rows[0].id), reference: rows[0].reference } : null
  } catch (e) {
    // Never blocks checkout: no promotion found means full price, exactly as before this existed.
    console.error('[diner-promotions] lookup failed (checkout continues at full price):', e instanceof Error ? e.message : e)
    return null
  }
}

/** Take the promotion for an order about to be placed. False when it was used or expired meanwhile. */
export async function reserveForOrder(promotionId: number): Promise<boolean> {
  const rows = (await sql`
    UPDATE disco_diner_promotions SET status = 'USED', used_at = NOW(), updated_at = NOW()
     WHERE id = ${promotionId} AND status = 'ACTIVATED' AND expires_at > NOW()
    RETURNING id
  `) as unknown[]
  return rows.length > 0
}

/** Placement threw after the promotion was taken: give it back. */
export async function releaseReservation(promotionId: number): Promise<void> {
  await sql`
    UPDATE disco_diner_promotions SET status = 'ACTIVATED', used_at = NULL, updated_at = NOW()
     WHERE id = ${promotionId} AND status = 'USED' AND order_reference IS NULL
  `.catch((e) => console.error('[diner-promotions] release after failed placement:', e instanceof Error ? e.message : e))
}

/** The order exists: record which order used the promotion and what Disco waived. */
export async function finalizeForOrder(promotionId: number, order: { orderReference: string; orderNumber: number; waived: number; source: string }): Promise<void> {
  await sql`
    UPDATE disco_diner_promotions
       SET order_reference = ${order.orderReference}::uuid, order_number = ${order.orderNumber}, waived_amount = ${order.waived}, updated_at = NOW()
     WHERE id = ${promotionId}
  `
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    VALUES (${order.orderReference}::uuid, 'FREE_DELIVERY_APPLIED', ${JSON.stringify({ promotionId, waivedFee: order.waived, fundedBy: 'DISCO' })}::jsonb, ${order.source})
  `.catch((e) => console.error('[diner-promotions] applied event:', e instanceof Error ? e.message : e))
}

/**
 * The order that used a promotion won't go ahead with a courier (abandoned checkout, cancelled
 * before delivery, switched to pickup or self-delivery): the promotion goes back to ACTIVATED and the
 * order no longer records a Disco-waived fee. Never throws; returns whether anything was restored.
 */
export async function releaseForOrder(orderReference: string, reason: string, source: string): Promise<boolean> {
  try {
    const rows = (await sql`
      UPDATE disco_diner_promotions
         SET status = 'ACTIVATED', used_at = NULL, order_reference = NULL, order_number = NULL, waived_amount = NULL, updated_at = NOW()
       WHERE order_reference = ${orderReference}::uuid AND status = 'USED'
      RETURNING id
    `) as { id: number }[]
    if (!rows.length) return false
    await sql`
      UPDATE disco_sale_transactions SET disco_promo_delivery_waived = 0, updated_at = NOW()
       WHERE order_id = (SELECT id FROM disco_orders WHERE reference = ${orderReference}::uuid LIMIT 1)
    `
    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${orderReference}::uuid, 'FREE_DELIVERY_RESTORED', ${JSON.stringify({ promotionIds: rows.map((r) => Number(r.id)), reason })}::jsonb, ${source})
    `
    return true
  } catch (e) {
    console.error('[diner-promotions] releaseForOrder failed:', orderReference, e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * Cancelled or voided: the promotion goes back to ACTIVATED only when this happens BEFORE the order's
 * scheduled delivery time (rule 3). Expedite reports no deliveries, so the scheduled time — the order's
 * date and time in the restaurant's zone — is the only signal for "before delivery".
 */
export async function releaseForCancelledOrder(orderReference: string, source: string): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT 1 FROM disco_orders o
        LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
       WHERE o.reference = ${orderReference}::uuid
         AND ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York')) > NOW()
       LIMIT 1
    `) as unknown[]
    if (!rows.length) return false
    return await releaseForOrder(orderReference, 'cancelled before delivery', source)
  } catch (e) {
    console.error('[diner-promotions] releaseForCancelledOrder failed:', orderReference, e instanceof Error ? e.message : e)
    return false
  }
}

/** The delivery fee Disco waived on this order (0 when none) — frozen into edit re-pricing. */
export async function waivedForOrder(orderReference: string): Promise<number> {
  try {
    const rows = (await sql`
      SELECT waived_amount FROM disco_diner_promotions WHERE order_reference = ${orderReference}::uuid AND status = 'USED' LIMIT 1
    `) as { waived_amount: string | null }[]
    return Number(rows[0]?.waived_amount) || 0
  } catch {
    return 0
  }
}

// ── Email ──────────────────────────────────────────────────────────────────────

function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function longDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function freeDeliveryEmail(p: Pick<DinerPromotion, 'reference' | 'restaurantName' | 'restaurantSlug' | 'expiresOn'>, firstName?: string): { subject: string; html: string } {
  const activateUrl = `${SITE_URL}/account/promotions?activate=${encodeURIComponent(p.reference)}`
  const orderUrl = p.restaurantSlug ? `${SITE_URL}/restaurants/${encodeURIComponent(p.restaurantSlug)}` : null
  const subject = `You've got free delivery on your next order from ${p.restaurantName}`
  const content = `
<p style="margin:0 0 12px 0;">${firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'}</p>
<p style="margin:0 0 12px 0;">You've got <strong>free delivery</strong> on your next order from <strong>${escapeHtml(p.restaurantName)}</strong>.</p>
<p style="margin:0 0 4px 0;">Activate it, then place a delivery order from ${escapeHtml(p.restaurantName)}: the delivery fee comes off at checkout.</p>
${button('Activate free delivery', activateUrl)}
<p style="margin:0 0 12px 0;color:#727272;font-size:13px;">Valid until ${escapeHtml(longDate(p.expiresOn))}, for one delivery order.${orderUrl ? ` <a href="${escapeHtml(orderUrl)}" style="color:#5B6FE8;">Order from ${escapeHtml(p.restaurantName)}</a>.` : ''}</p>
`
  return { subject, html: layout(content) }
}

async function sendFreeDeliveryPromotionEmail(p: DinerPromotion, firstName?: string) {
  const { subject, html } = freeDeliveryEmail(p, firstName)
  return sendEmail({ to: p.customerEmail, subject, html, tags: ['diner-promotion'] })
}
