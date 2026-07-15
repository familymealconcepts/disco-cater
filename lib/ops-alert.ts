// Loud, best-effort operational alert for silent-failure paths — a paid order
// that fails to mirror into Neon, a swallowed sync skip, a stalled cursor, etc.
// Posts to a Slack webhook when configured; always logs with a [OPS-ALERT] prefix
// so the signal exists in Vercel logs even without Slack. Never throws.
//
// Uses SLACK_ALERT_WEBHOOK_URL when set, else falls back to the new-order webhook
// so alerts land somewhere a human watches rather than being lost.
export async function alertOps(message: string, context?: Record<string, unknown>): Promise<void> {
  const line = `[OPS-ALERT] ${message}${context ? ' ' + safeJson(context) : ''}`
  // Always log — this is the guaranteed signal.
  console.error(line)

  const url = process.env.SLACK_ALERT_WEBHOOK_URL || process.env.SLACK_NEW_ORDER_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `:rotating_light: ${line}` }),
    })
  } catch {
    /* best-effort — the console.error above is the durable record */
  }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}
