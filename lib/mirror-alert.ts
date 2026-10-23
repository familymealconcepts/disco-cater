import { sql } from './db'
import { alertOps, alertOnce, type OpsAlert } from './ops-alert'

export type MirrorAlertKind = 'cursor-stalled' | 'restaurants-failed' | 'order-gap' | 'run-failed'
  | 'watch-stale' | 'watch-fetch-failed'

/**
 * An audit row for the FamilyMeal-mirror alarms.
 *
 * Slack cannot be queried from the app, and `vercel logs` returns a capped
 * window of mixed traffic, so a cron's own lines are gone within minutes on a
 * busy site. That made "did the alarm fire?" unanswerable — the same blind spot
 * that let the mirror sit dead for 51 hours. So every mirror alarm also writes
 * one row. Best-effort by design: a failure to record must never stop the alert
 * itself, and must never fail the cron that raised it.
 */
export async function recordMirrorAlert(kind: MirrorAlertKind, message: string, detail?: Record<string, unknown>): Promise<void> {
  try {
    await sql`
      INSERT INTO disco_mirror_alerts (kind, detail)
      VALUES (${kind}, ${JSON.stringify({ message, ...(detail || {}) })}::jsonb)
    `
  } catch (e) {
    console.error('[mirror-alert] audit row failed (alert itself was sent):', e instanceof Error ? e.message : e)
  }
}

/** Post (once per key when one is given) and record the audit row. */
export async function mirrorAlert(kind: MirrorAlertKind, alert: OpsAlert, opts?: { key?: string }): Promise<void> {
  const posted = opts?.key ? await alertOnce(opts.key, alert) : (await alertOps(alert), true)
  if (posted) await recordMirrorAlert(kind, alert.headline, alert.context)
}
