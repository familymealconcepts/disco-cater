// A FamilyMeal-processed order's status change must land in FamilyMeal FIRST, or not at all.
//
// THE BUG (#43997813, Westwoods BBQ & Spice Co., cancelled in the portal 15 Nov 2026): the portal's status
// route sent the change to FamilyMeal "best-effort" and wrote Disco regardless. For a restaurant whose users
// have no FamilyMeal sign-in (every converted restaurant), the call went out with the SUPER_ADMIN service
// account to FamilyMeal's RESTAURANT endpoint (/api/orders/{ref}/updateStatus), which needs a user tied to a
// restaurant; the service account has none, so FamilyMeal refused every time. Disco showed "Cancelled", the
// FamilyMeal sync then copied FamilyMeal's status back over it, and the order sat "Reopened" in both.
//
// NOW: the change goes through FamilyMeal's super-admin status change, scoped to the order's own restaurant
// (PUT /api/admin/userOrders/{fmRef}?restaurantReference=&orderStatus=, the same changeOrderStatus FamilyMeal's
// restaurant endpoint runs, so its side effects are identical: courier/Shipday cancel and FamilyMeal's own
// cancellation emails; it never refunds). The caller writes Disco only when this returns ok. A refusal comes
// back as a sentence the restaurant can act on, and nothing is changed anywhere.
//
// Disco-native orders (no fm_order_reference) are not FamilyMeal's and are skipped.
import { sql } from '../db'
import { getFmServiceToken } from '../fm-service-auth'
import { fmFetch } from '../fm-fetch'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

/** Disco's status spellings → FamilyMeal's OrderStatus enum. */
export function fmStatusFor(status: string): string {
  const s = status.toUpperCase()
  if (s === 'CANCELLED') return 'CANCELED'
  if (s === 'VOIDED') return 'VOID'
  if (s === 'REFUNDED') return 'REFUND'
  return s
}

const LABEL: Record<string, string> = {
  CANCELED: 'Cancelled', DUE: 'Due', COMPLETED: 'Completed', REOPEN: 'Reopened', VOID: 'Void', REFUND: 'Refunded',
  RESERVED: 'Reserved', EXPIRED: 'Expired', PAID: 'Paid', UNPAID: 'Unpaid', PARTIALLY_PAID: 'Partially paid',
}
const label = (s: string | null | undefined) => (s ? LABEL[s] ?? s : 'its current status')

/** The sentence a restaurant sees when FamilyMeal refuses. Pure, so it is pinned by a test. */
export function fmRefusalMessage(target: string, current: string | null, fmLabel: string | null): string {
  if (fmLabel === 'STATUS_CHANGE_NOT_ALLOWED') {
    const hint = current === 'REOPEN' && target === 'CANCELED' ? ' Set it to Due first, then cancel it.' : ''
    return `FamilyMeal processed this order and won't change it from ${label(current)} to ${label(target)}, so nothing was changed.${hint}`
  }
  return 'FamilyMeal processed this order and did not accept the change, so nothing was changed. Try again in a minute, or contact Disco Cater support.'
}

export type FmStatusResult = { ok: true; fm: boolean } | { ok: false; status: number; error: string }

/**
 * `restaurantRef`: Super Admin passes the order's restaurant, so an order FamilyMeal has but Disco has not
 * mirrored yet still reaches FamilyMeal (the ref is then FamilyMeal's own).
 */
export async function setFamilyMealOrderStatus(ref: string, status: string, restaurantRef?: string | null): Promise<FmStatusResult> {
  const rows = (await sql`
    SELECT fm_order_reference::text AS fm, restaurant_reference::text AS rr
      FROM disco_orders WHERE (reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid) AND is_deleted = false
     LIMIT 1
  `) as { fm: string | null; rr: string | null }[]
  const o = rows[0] ?? (restaurantRef ? { fm: ref, rr: restaurantRef } : undefined)
  if (!o?.fm) return { ok: true, fm: false }
  if (!o.rr) return { ok: false, status: 409, error: fmRefusalMessage(fmStatusFor(status), null, null) }

  const target = fmStatusFor(status)
  try {
    const token = await getFmServiceToken()
    const h = { Authorization: token, Accept: 'application/json' }
    const url = `${FM}/api/admin/userOrders/${o.fm}?restaurantReference=${o.rr}`
    // ONE attempt, not fmFetch's retry: a PUT FamilyMeal applied before a gateway timeout would be sent again,
    // and CANCELED -> CANCELED is allowed there, so the customer and restaurant would get a second set of emails.
    const res = await fetch(`${url}&orderStatus=${encodeURIComponent(target)}`, { method: 'PUT', headers: h, signal: AbortSignal.timeout(15_000) })
    if (res.ok) return { ok: true, fm: true }
    const body = (await res.json().catch(() => null)) as { label?: string } | null
    // Read FamilyMeal's current status so the message names it, not Disco's possibly stale copy.
    const current = await fmFetch(url, { headers: h }).then((r) => (r.ok ? r.json() : null)).then((j) => (j as { orderStatus?: string } | null)?.orderStatus ?? null).catch(() => null)
    console.error('[fm-order-status] FamilyMeal refused', ref, target, res.status, body?.label ?? '')
    return { ok: false, status: 409, error: fmRefusalMessage(target, current, body?.label ?? null) }
  } catch (e) {
    console.error('[fm-order-status] FamilyMeal unreachable', ref, target, e instanceof Error ? e.message : e)
    return { ok: false, status: 502, error: fmRefusalMessage(target, null, null) }
  }
}
