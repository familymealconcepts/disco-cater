// Operational alerts for #ops-alerts (Slack channel C0C21FDU8KT). Always logs
// with an [OPS-ALERT] prefix, so the signal exists in Vercel logs even without
// Slack. Never throws.
//
// WHAT A MESSAGE SAYS lives in lib/ops-alert-format.ts: a plain headline, who is
// affected, what to do, a link — and never raw JSON. This file decides WHEN and
// WHERE it is sent.
//
// TRANSPORT. With SLACK_OPS_ALERTS_BOT_TOKEN set, messages go through
// chat.postMessage, which returns the message's ts — and that ts is what lets a
// "resolved" land as a reply in the alert's own thread. Without it, the
// incoming webhook SLACK_NOTIFICATIONS_WEBHOOK_URL is used: it cannot thread,
// so a resolve posts top-level starting ✅ and naming the alert it closes.
// Both variables point at #ops-alerts; neither falls back to #orders. (That
// fallback used to exist "so alerts land somewhere a human watches" and it was
// the bug: every ops alert silently posted to the channel restaurants read.)
//
// ── THE RULE, and it applies to every alert in this codebase ──────────────────
//
//   AN ALERT FIRES WHEN A CONDITION NEWLY BECOMES TRUE, NOT ON EVERY CHECK
//   WHILE IT REMAINS TRUE — AND WHEN IT CLEARS, IT SAYS SO ONCE, IN ITS THREAD.
//   Anything that cannot express that is a REPORT, and belongs in a log or
//   behind a query — not in a chat channel.
//
// Why. A cron that checks every fifteen minutes and alerts whenever a condition
// holds reports one problem ninety-six times a day. That is not hypothetical:
// order 31086 (#900000463) posted "dispatch FAILED" 61 times between 10-19 and
// 10-20, and refresh-restaurant-admin-list posted ~60 times during one FamilyMeal
// outage on 09-19.
//
// alertOnce(key, alert) posts the first time a key is seen, stores the Slack ts,
// and stays silent while the key stays open. resolveAlert(key, text) replies in
// that thread and closes the key — so if the condition comes back later, it is
// news again and posts fresh. Before 2026-10-23 a key could never clear: once an
// order's courier alert had fired, that order could never alert again.
//
// CHOOSING A KEY is the caller's real decision. It must identify the CONDITION,
// not the check — the order/restaurant/entity and the kind of problem, and
// nothing that changes between runs. A timestamp in the key defeats the whole
// mechanism.
//
// FAIL-OPEN. If the ledger is unreachable the alert is sent rather than dropped:
// a duplicate alert is an annoyance, a swallowed one is the failure this whole
// channel exists to prevent.
import { sql, runAlertDedupMigrations } from './db'
import {
  type OpsAlert, renderAlert, renderReply, renderTopLevelResolve, jobFailureAlert, jobRecoveredText, JOBS,
} from './ops-alert-format'

export type { OpsAlert } from './ops-alert-format'

const DEFAULT_CHANNEL = 'C0C21FDU8KT' // #ops-alerts

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** Post to #ops-alerts. Returns the message ts when it went through the bot token, else null. */
async function post(text: string, opts?: { threadTs?: string | null; broadcast?: boolean }): Promise<string | null> {
  const token = process.env.SLACK_OPS_ALERTS_BOT_TOKEN
  if (token) {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          channel: process.env.SLACK_OPS_ALERTS_CHANNEL_ID || DEFAULT_CHANNEL,
          text,
          unfurl_links: false,
          unfurl_media: false,
          ...(opts?.threadTs ? { thread_ts: opts.threadTs, ...(opts.broadcast ? { reply_broadcast: true } : {}) } : {}),
        }),
      })
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string }
      if (j.ok && j.ts) return j.ts
      console.error('[ops-alert] chat.postMessage failed, trying the webhook:', j.error ?? res.status)
    } catch (e) {
      console.error('[ops-alert] chat.postMessage threw, trying the webhook:', e instanceof Error ? e.message : e)
    }
  }
  const url = process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL
  if (!url) return null
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    })
  } catch {
    /* best-effort — the console line is the durable record */
  }
  return null
}

function log(a: OpsAlert, key?: string): void {
  console.error(`[OPS-ALERT] ${a.headline}${key ? ` [${key}]` : ''}${a.context ? ' ' + safeJson(a.context) : ''}`)
}

/**
 * A one-shot event ("this transfer failed"): posts every time it is called.
 * Correct only for something that happens once. A condition a schedule
 * re-checks must use alertOnce. Returns the Slack ts when known.
 */
export async function alertOps(a: OpsAlert): Promise<string | null> {
  log(a)
  return post(renderAlert(a))
}

/**
 * Top-level "✅ <headline> / <text>" with no ledger at all — for the one caller
 * that must not touch the database: the campaign retry while the database is
 * the thing that is down (lib/marketing/transient-retry.ts).
 */
export async function postResolvedNoLedger(headline: string, text: string): Promise<void> {
  console.error(`[OPS-ALERT resolved] ${headline}: ${text}`)
  await post(renderTopLevelResolve(headline, text))
}

/**
 * Post once per open key. Returns true if this call posted.
 *
 * A resolved key RE-ARMS: the condition came back after being cleared, which
 * is news, so it posts fresh and starts a new thread.
 */
export async function alertOnce(alertKey: string, a: OpsAlert): Promise<boolean> {
  log(a, alertKey)
  try {
    await runAlertDedupMigrations()
    // Re-arm first. A conditional UPDATE is atomic per row: of two racing
    // lambdas only one sees resolved_at IS NOT NULL, so only one re-posts.
    const rearmed = (await sql`
      UPDATE disco_alert_dedup
         SET resolved_at = NULL, slack_ts = NULL, times_seen = 1, first_alerted_at = NOW(),
             last_seen_at = NOW(), headline = ${a.headline}, note = ${a.headline.slice(0, 500)}
       WHERE alert_key = ${alertKey} AND resolved_at IS NOT NULL
      RETURNING alert_key`) as unknown[]
    let isFirst = rearmed.length > 0
    if (!isFirst) {
      // ON CONFLICT DO UPDATE ... RETURNING (xmax = 0) is the standard Postgres
      // idiom for "this tuple was inserted, not updated": two concurrent calls
      // on one key produce exactly one insert and therefore exactly one post.
      const rows = (await sql`
        INSERT INTO disco_alert_dedup (alert_key, note, headline)
        VALUES (${alertKey}, ${a.headline.slice(0, 500)}, ${a.headline})
        ON CONFLICT (alert_key) DO UPDATE
          SET last_seen_at = NOW(), times_seen = disco_alert_dedup.times_seen + 1
        RETURNING (xmax = 0) AS inserted, times_seen
      `) as Array<{ inserted: boolean; times_seen: number }>
      isFirst = rows[0]?.inserted === true
      if (!isFirst) {
        console.log(`[OPS-ALERT suppressed x${rows[0]?.times_seen ?? '?'}] ${alertKey}`)
        return false
      }
    }
    const ts = await post(renderAlert(a))
    if (ts) await sql`UPDATE disco_alert_dedup SET slack_ts = ${ts} WHERE alert_key = ${alertKey}`.catch(() => {})
    return true
  } catch (err) {
    console.error('[ops-alert] dedup ledger unavailable, alerting anyway:', err instanceof Error ? err.message : err)
    await post(renderAlert(a))
    return true
  }
}

/**
 * One message for several conditions found in the same run ("2 converted
 * restaurants can't take card payments"), each still its own key so each can
 * close on its own — every key gets the message's ts, so each resolve replies
 * in the thread that named it. `build` receives only the keys that are NEW, and
 * nothing posts if there are none.
 */
export async function alertGroup<T extends { key: string }>(items: T[], build: (fresh: T[]) => OpsAlert): Promise<T[]> {
  if (!items.length) return []
  let fresh: T[] = items
  try {
    await runAlertDedupMigrations()
    fresh = []
    for (const it of items) {
      const rearmed = (await sql`
        UPDATE disco_alert_dedup SET resolved_at = NULL, slack_ts = NULL, times_seen = 1, first_alerted_at = NOW(), last_seen_at = NOW()
         WHERE alert_key = ${it.key} AND resolved_at IS NOT NULL RETURNING alert_key`) as unknown[]
      const inserted = rearmed.length ? rearmed : (await sql`
        INSERT INTO disco_alert_dedup (alert_key, note) VALUES (${it.key}, 'group')
        ON CONFLICT (alert_key) DO UPDATE SET last_seen_at = NOW(), times_seen = disco_alert_dedup.times_seen + 1
        RETURNING CASE WHEN xmax = 0 THEN alert_key END AS alert_key`) as Array<{ alert_key: string | null }>
      if ((inserted[0] as { alert_key?: string | null } | undefined)?.alert_key) fresh.push(it)
    }
  } catch (err) {
    console.error('[ops-alert] dedup ledger unavailable, alerting on every item:', err instanceof Error ? err.message : err)
  }
  if (!fresh.length) return []
  const a = build(fresh)
  log(a, fresh.map(f => f.key).join(','))
  const ts = await post(renderAlert(a))
  try {
    await sql`UPDATE disco_alert_dedup SET slack_ts = ${ts}, headline = ${a.headline} WHERE alert_key = ANY(${fresh.map(f => f.key)})`
  } catch { /* the post went out; only threading is lost */ }
  return fresh
}

type OpenRow ={ alert_key: string; slack_ts: string | null; headline: string | null }

async function openRow(alertKey: string): Promise<OpenRow | null> {
  const rows = (await sql`
    SELECT alert_key, slack_ts, headline FROM disco_alert_dedup
     WHERE alert_key = ${alertKey} AND resolved_at IS NULL`) as OpenRow[]
  return rows[0] ?? null
}

/**
 * A follow-up on an open alert that does NOT close it: "pickup is in 7
 * minutes", "Expedite will keep refusing". Each distinct `step` posts once.
 * `broadcast` also shows the reply in the channel, for the ones someone must
 * act on now. Without a thread (webhook transport) it posts top-level.
 */
export async function replyToAlert(
  alertKey: string, step: string, text: string,
  opts?: { broadcast?: boolean; severity?: 'urgent' | 'warn'; action?: string },
): Promise<boolean> {
  try {
    await runAlertDedupMigrations()
    const row = await openRow(alertKey)
    if (!row) return false
    const stepKey = `${alertKey}#${step}`
    const claimed = (await sql`
      INSERT INTO disco_alert_dedup (alert_key, note) VALUES (${stepKey}, ${text.slice(0, 500)})
      ON CONFLICT (alert_key) DO NOTHING RETURNING alert_key`) as unknown[]
    if (!claimed.length) return false
    console.error(`[OPS-ALERT] ${alertKey} → ${step}: ${text}`)
    const body = renderReply(text, { severity: opts?.severity, action: opts?.action })
    await post(row.slack_ts ? body : `${body}${row.headline ? `\n_(${row.headline})_` : ''}`, { threadTs: row.slack_ts, broadcast: opts?.broadcast })
    return true
  } catch (err) {
    console.error('[ops-alert] reply failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Close an open alert: "✅ <text>" in its thread, once. Returns true if this
 * call closed it. A key that was never opened, or is already closed, is a no-op
 * — so callers can resolve on every clean check without remembering anything.
 */
export async function resolveAlert(alertKey: string, text: string): Promise<boolean> {
  try {
    await runAlertDedupMigrations()
    const rows = (await sql`
      UPDATE disco_alert_dedup SET resolved_at = NOW()
       WHERE alert_key = ${alertKey} AND resolved_at IS NULL
      RETURNING slack_ts, headline`) as Array<{ slack_ts: string | null; headline: string | null }>
    if (!rows.length) return false
    // Step markers belong to the closed thread; clear them so a re-armed alert can escalate again.
    await sql`DELETE FROM disco_alert_dedup WHERE alert_key LIKE ${`${alertKey}#%`}`.catch(() => {})
    console.error(`[OPS-ALERT resolved] ${alertKey}: ${text}`)
    const { slack_ts, headline } = rows[0]
    await post(slack_ts ? renderReply(text, { resolved: true }) : renderTopLevelResolve(headline, text), { threadTs: slack_ts })
    return true
  } catch (err) {
    console.error('[ops-alert] resolve failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Every open key under a prefix — for the checks that resolve by looking at the world again. */
export async function openAlertKeys(prefix: string): Promise<string[]> {
  try {
    await runAlertDedupMigrations()
    const rows = (await sql`
      SELECT alert_key FROM disco_alert_dedup
       WHERE alert_key LIKE ${`${prefix}%`} AND alert_key NOT LIKE '%#%' AND resolved_at IS NULL`) as Array<{ alert_key: string }>
    return rows.map(r => r.alert_key)
  } catch (err) {
    console.error('[ops-alert] open keys unavailable:', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * For list-type checks (missing FM orders, bare orders, restaurants off the
 * map): every open key under `prefix` that is NOT in `stillTrue` is resolved
 * with its own text. Call it after a SUCCESSFUL check only — a check that
 * failed has not seen the world, and resolving from it would close real
 * problems.
 */
export async function syncAlertSet(prefix: string, stillTrue: Iterable<string>, resolvedText: (key: string) => string): Promise<string[]> {
  const keep = new Set(stillTrue)
  const closed: string[] = []
  for (const k of await openAlertKeys(prefix)) {
    if (keep.has(k)) continue
    if (await resolveAlert(k, resolvedText(k))) closed.push(k)
  }
  return closed
}

// ── Transient failures ────────────────────────────────────────────────────────
// A job alerts only after JOBS[job].threshold failed runs in a row, and says
// "Recovered" in the same thread on its next success. The counter lives in the
// ledger under `job-run:<job>`, separate from the alert key `job:<job>`.

export async function noteJobFailure(job: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error ?? '')
  console.error(`[OPS-ALERT job-failure] ${job}: ${message}`)
  const threshold = JOBS[job]?.threshold ?? 1
  let failures = threshold
  try {
    await runAlertDedupMigrations()
    const rows = (await sql`
      INSERT INTO disco_alert_dedup (alert_key, note, fail_count) VALUES (${`job-run:${job}`}, ${message.slice(0, 500)}, 1)
      ON CONFLICT (alert_key) DO UPDATE
        SET fail_count = COALESCE(disco_alert_dedup.fail_count, 0) + 1, last_seen_at = NOW(), note = EXCLUDED.note
      RETURNING fail_count`) as Array<{ fail_count: number }>
    failures = rows[0]?.fail_count ?? threshold
  } catch (err) {
    console.error('[ops-alert] failure counter unavailable, alerting on this failure:', err instanceof Error ? err.message : err)
  }
  if (failures < threshold) return
  await alertOnce(`job:${job}`, { ...jobFailureAlert(job, failures, message), context: { job, failures, error: message } })
}

export async function noteJobSuccess(job: string): Promise<void> {
  try {
    await runAlertDedupMigrations()
    // RETURNING sees the new row, so the old count comes from a CTE read in the same statement.
    const rows = (await sql`
      WITH old AS (SELECT fail_count FROM disco_alert_dedup WHERE alert_key = ${`job-run:${job}`} FOR UPDATE)
      UPDATE disco_alert_dedup d SET fail_count = 0, last_seen_at = NOW()
        FROM old
       WHERE d.alert_key = ${`job-run:${job}`} AND COALESCE(old.fail_count, 0) > 0
      RETURNING old.fail_count AS was`) as Array<{ was: number }>
    if (!rows.length) return
    // A no-op unless the failures had reached the threshold and posted.
    await resolveAlert(`job:${job}`, jobRecoveredText(Number(rows[0].was) || 1, new Date()))
  } catch (err) {
    console.error('[ops-alert] success note failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}

/**
 * Pre-record an alert key WITHOUT sending anything, so a known condition starts
 * suppressed.
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

// ── Per-item streaks ──────────────────────────────────────────────────────────
// The same threshold idea per restaurant rather than per job: "FamilyMeal order
// sync failing for 2 restaurants — skipped 2 runs in a row". bumpStreaks counts
// a failure for each id and returns the new counts; clearStreaks zeroes the ids
// that worked this run and returns the ones that had been failing.

export async function bumpStreaks(prefix: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!ids.length) return out
  try {
    await runAlertDedupMigrations()
    for (const id of ids) {
      const rows = (await sql`
        INSERT INTO disco_alert_dedup (alert_key, note, fail_count) VALUES (${`streak:${prefix}${id}`}, 'streak', 1)
        ON CONFLICT (alert_key) DO UPDATE
          SET fail_count = COALESCE(disco_alert_dedup.fail_count, 0) + 1, last_seen_at = NOW()
        RETURNING fail_count`) as Array<{ fail_count: number }>
      out.set(id, rows[0]?.fail_count ?? 1)
    }
  } catch (err) {
    console.error('[ops-alert] streak counter unavailable; treating as threshold reached:', err instanceof Error ? err.message : err)
    for (const id of ids) out.set(id, Number.MAX_SAFE_INTEGER)
  }
  return out
}

export async function clearStreaks(prefix: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  try {
    await runAlertDedupMigrations()
    const rows = (await sql`
      UPDATE disco_alert_dedup SET fail_count = 0, last_seen_at = NOW()
       WHERE alert_key = ANY(${ids.map(id => `streak:${prefix}${id}`)}) AND COALESCE(fail_count, 0) > 0
      RETURNING alert_key`) as Array<{ alert_key: string }>
    return rows.map(r => r.alert_key.slice(`streak:${prefix}`.length))
  } catch {
    return []
  }
}
