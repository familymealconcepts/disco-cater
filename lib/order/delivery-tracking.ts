// The courier tracking link (Expedite's `result_tracking_link`) for diner and restaurant emails and the
// diner's order page. FamilyMeal saves it from the booking response and prints "track your delivery"
// in its order emails (DlivrdDeliveryServiceImpl.createDelivery -> RestaurantOrder.resultTrackingLink);
// this is the same thing for Disco.
//
// THIRD-PARTY (EXPEDITE) DELIVERY ONLY. Pickup and self-delivery orders never get a tracking line, even
// if a link were somehow stored, so every reader goes through loadDeliveryTrackingUrl / trackingUrlFor.
import { waitUntil } from '@vercel/functions'
import { sql } from '../db'
import { isThirdPartyFulfillment } from './fulfillment-label'

/** Only a real https link is ever stored or shown. */
export function cleanTrackingUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return /^https:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 1000 ? s : null
}

/** Expedite's booking response carries the link at data.result_tracking_link. */
export function trackingUrlFromExpediteResponse(json: Record<string, unknown> | undefined): string | null {
  if (!json) return null
  const data = json.data && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data as Record<string, unknown> : undefined
  return cleanTrackingUrl(data?.result_tracking_link) ?? cleanTrackingUrl(json.result_tracking_link)
}

/** The link for an order row already in hand: null unless it is a third-party delivery. */
export function trackingUrlFor(o: { delivery_type?: unknown; expedite_tracking_url?: unknown }): string | undefined {
  if (!isThirdPartyFulfillment(o.delivery_type == null ? null : String(o.delivery_type))) return undefined
  return cleanTrackingUrl(o.expedite_tracking_url) ?? undefined
}

/** The link for an order by its Disco id or reference. Never throws; undefined when there is none. */
export async function loadDeliveryTrackingUrl(order: { id?: number | string; reference?: string }): Promise<string | undefined> {
  try {
    const rows = (order.id != null
      ? await sql`SELECT delivery_type, expedite_tracking_url FROM disco_orders WHERE id = ${Number(order.id)} LIMIT 1`
      : await sql`SELECT delivery_type, expedite_tracking_url FROM disco_orders WHERE reference = ${String(order.reference)}::uuid LIMIT 1`
    ) as { delivery_type: string | null; expedite_tracking_url: string | null }[]
    return rows[0] ? trackingUrlFor(rows[0]) : undefined
  } catch {
    return undefined
  }
}

/** How long the confirmation waits for the courier booking before going out without the link. */
export const BOOKING_WAIT_MS = 10_000

/**
 * Book the courier first, then send the confirmation, so the confirmation can carry the tracking link
 * (FamilyMeal at its best). The confirmation never waits more than BOOKING_WAIT_MS: a slow booking keeps
 * running in the background (waitUntil) and the confirmation goes out without the link; a failed one
 * (dispatchExpediteForOrder never throws) sends it at once. Pickup and self-delivery orders are refused
 * by the booking's own claim immediately, so their confirmation is not delayed at all.
 */
export async function bookCourierThenConfirm(
  book: (() => Promise<void>) | null,
  confirm: () => Promise<void>,
  waitMs = BOOKING_WAIT_MS,
): Promise<void> {
  if (book) {
    const booking = book().catch((e) => console.error('[delivery-tracking] courier booking threw:', e instanceof Error ? e.message : e))
    try { waitUntil(booking) } catch { /* outside a request (scripts/tests): the await below still bounds it */ }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([booking, new Promise<void>((r) => { timer = setTimeout(r, waitMs) })])
    if (timer) clearTimeout(timer)
  }
  await confirm()
}
