import { sql } from './db'
import { alertOps } from './ops-alert'

/**
 * alertOps + an audit row, for the FamilyMeal-mirror alarms specifically.
 *
 * alertOps posts to Slack and prints `[OPS-ALERT]` to the Vercel log. Neither
 * is readable afterwards: Slack cannot be queried from the app, and
 * `vercel logs` returns a capped window of mixed traffic, so a cron's own lines
 * are gone within minutes on a busy site. That made "did the alarm fire?"
 * unanswerable — the same blind spot that let the mirror sit dead for 51 hours.
 *
 * So every mirror alarm also writes one row. Best-effort by design: a failure
 * to record must never stop the alert itself from going out, and must never
 * fail the cron that raised it.
 */
export async function mirrorAlert(
  kind: 'cursor-stalled' | 'restaurants-failed' | 'order-gap' | 'run-failed',
  message: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await alertOps(message, detail)
  try {
    await sql`
      INSERT INTO disco_mirror_alerts (kind, detail)
      VALUES (${kind}, ${JSON.stringify({ message, ...(detail || {}) })}::jsonb)
    `
  } catch (e) {
    console.error('[mirror-alert] audit row failed (alert itself was sent):', e instanceof Error ? e.message : e)
  }
}
