// Loud, best-effort operational alert for silent-failure paths — a paid order
// that fails to mirror into Neon, a swallowed sync skip, a stalled cursor, etc.
// Posts to Slack #notifications when configured; always logs with a
// [OPS-ALERT] prefix so the signal exists in Vercel logs even without Slack.
// Never throws.
//
// Uses SLACK_NOTIFICATIONS_WEBHOOK_URL only — NO fallback to the new-order
// webhook. That fallback used to exist (falling back to #orders "so alerts
// land somewhere a human watches") and it was the actual bug: since this var
// was never configured, every ops alert silently posted to #orders instead —
// the channel restaurants/staff read for real order notifications, not
// operational noise. If this var is unset, the alert now stays
// console-only (still a durable signal in Vercel logs) rather than
// defaulting to the wrong channel.
export async function alertOps(message: string, context?: Record<string, unknown>): Promise<void> {
  const line = `[OPS-ALERT] ${message}${context ? ' ' + safeJson(context) : ''}`
  // Always log — this is the guaranteed signal.
  console.error(line)

  const url = process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL
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
