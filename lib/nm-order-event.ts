import { waitUntil } from '@vercel/functions'

/**
 * Tells NM OS (dashboard.discocater.com) about an order that was just announced to Slack #orders,
 * so it can treat it as a "new order" event (its first use: NM Messenger #orders).
 *
 * ADDITIVE. Called AFTER the Slack post has been sent, and nothing here can delay, fail or change
 * that post, the order, or checkout:
 *   - sends only the order reference; NM OS reads everything else itself, read-only;
 *   - non-blocking: handed to waitUntil and returns immediately, even at plain-await call sites;
 *   - 3-second timeout; every failure is logged, never thrown;
 *   - a no-op when NM_ORDER_EVENT_SECRET is unset, so local dev and previews send nothing.
 * A missed call is not lost: NM OS also sweeps SLACK_NOTIFIED events every 15 minutes.
 *
 * Env: NM_ORDER_EVENT_SECRET (same value as NM OS's), optional NM_ORDER_EVENT_URL.
 */
const DEFAULT_URL = 'https://dashboard.discocater.com/api/webhooks/marketplace-order'
const TIMEOUT_MS = 3000

export function notifyNmOrderEvent(orderReference: string, source: string): void {
  try {
    const secret = process.env.NM_ORDER_EVENT_SECRET
    if (!secret || !orderReference) return
    const send = fetch(process.env.NM_ORDER_EVENT_URL || DEFAULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ type: 'order.created', orderReference, source }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) console.error(`[nm-order-event] NM OS answered ${res.status} for ${orderReference}`)
      })
      .catch((err) => {
        console.error('[nm-order-event] could not reach NM OS:', err instanceof Error ? err.message : err)
      })
    waitUntil(send)
  } catch (err) {
    console.error('[nm-order-event] skipped:', err instanceof Error ? err.message : err)
  }
}
