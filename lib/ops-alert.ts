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

// ── alertOnce ─────────────────────────────────────────────────────────────────
// THE RULE, and it applies to every alert in this codebase:
//
//   AN ALERT FIRES WHEN A CONDITION NEWLY BECOMES TRUE, NOT ON EVERY CHECK
//   WHILE IT REMAINS TRUE. Anything that cannot express that is a REPORT, and
//   belongs in a log or behind a query — not in a chat channel.
//
// Why this exists. alertOps() posts unconditionally, which is correct for a
// one-shot event ("this transfer failed") and catastrophic for a standing
// condition evaluated on a schedule. A cron that checks every fifteen minutes
// and alerts whenever a condition holds does not report a problem once; it
// reports it ninety-six times a day, forever, and the channel stops being read.
//
// That is not hypothetical. Within two hours of the ops channel going live,
// two jobs had made it unusable: the Expedite sweep re-announced the same four
// already-missed deliveries every fifteen minutes, and the bare-order check
// dumped 192 orders as raw JSON every hour. Both conditions were TRUE and
// UNCHANGED — and both alerts were correct exactly once.
//
// alertOnce() takes a caller-chosen key and fires only the first time that key
// is seen. Subsequent occurrences update a counter and stay silent, so the
// history is still readable afterwards without anyone being paged for it.
//
// CHOOSING A KEY is the caller's real decision. It must identify the CONDITION,
// not the check — include the order/restaurant/entity and the kind of problem,
// and nothing that changes between runs. A timestamp in the key defeats the
// whole mechanism.
//
// FAIL-OPEN. If the ledger is unreachable the alert is sent rather than dropped:
// a duplicate alert is an annoyance, a swallowed one is the failure this whole
// channel exists to prevent.
import { sql, runAlertDedupMigrations } from './db'

export async function alertOnce(
  alertKey: string,
  message: string,
  context?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await runAlertDedupMigrations()
    // ON CONFLICT DO UPDATE ... RETURNING tells us, atomically and in one
    // round trip, whether THIS call inserted the row. xmax = 0 is the standard
    // Postgres idiom for "this tuple was inserted, not updated" — two concurrent
    // lambdas racing the same key produce exactly one insert and therefore
    // exactly one alert.
    const rows = (await sql`
      INSERT INTO disco_alert_dedup (alert_key, note)
      VALUES (${alertKey}, ${message.slice(0, 500)})
      ON CONFLICT (alert_key) DO UPDATE
        SET last_seen_at = NOW(), times_seen = disco_alert_dedup.times_seen + 1
      RETURNING (xmax = 0) AS inserted, times_seen
    `) as Array<{ inserted: boolean; times_seen: number }>

    const isFirst = rows[0]?.inserted === true
    if (!isFirst) {
      // Deliberately console-only. Keeps the suppression itself auditable in the
      // Vercel log without touching Slack.
      console.log(`[OPS-ALERT suppressed x${rows[0]?.times_seen ?? '?'}] ${alertKey}`)
      return false
    }
    await alertOps(message, context)
    return true
  } catch (err) {
    console.error('[ops-alert] dedup ledger unavailable, alerting anyway:', err instanceof Error ? err.message : err)
    await alertOps(message, context)
    return true
  }
}

/**
 * Pre-record an alert key WITHOUT sending anything, so a known condition starts
 * suppressed. Used to silence conditions that were already alerted on before the
 * dedup ledger existed — backfilling the record is what makes the next run quiet
 * rather than waiting for the condition to clear.
 */
export async function suppressAlertKey(alertKey: string, note: string): Promise<void> {
  try {
    await runAlertDedupMigrations()
    await sql`
      INSERT INTO disco_alert_dedup (alert_key, note) VALUES (${alertKey}, ${note.slice(0, 500)})
      ON CONFLICT (alert_key) DO NOTHING`
  } catch (err) {
    console.error('[ops-alert] could not pre-suppress', alertKey, err instanceof Error ? err.message : err)
  }
}
