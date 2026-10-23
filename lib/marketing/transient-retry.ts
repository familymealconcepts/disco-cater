import { alertOps, alertOnce, resolveAlert, replyToAlert, postResolvedNoLedger, type OpsAlert } from '../ops-alert'
import { shortError } from '../ops-alert-format'

/**
 * Retry-with-backoff for the transient network failures that end a long send.
 *
 * ── WHY THIS MOVED OUT OF campaign-send.ts ──────────────────────────────────
 * It was withDbRetry, and it only ever wrapped database calls. On 15 Oct 2026 a
 * network blip proved that was half a fix: the DB layer retried seven times,
 * announced itself, and RECOVERED — and then the very next Mailgun call died on
 * an unguarded fetch and ended a 75-hour run at 53% sent.
 *
 *     [OPS-ALERT] campaign DB connectivity RECOVERED after 146s — the run continued
 *     [TypeError: fetch failed]
 *       [cause]: ConnectTimeoutError (api.mailgun.net:443, timeout: 10000ms)
 *
 * Both subsystems are reached over the same flaky laptop network, so both need
 * the same treatment. campaign-send.ts already imports campaign-health.ts, so
 * the shared helper cannot live in either — hence its own module.
 *
 * ── WHAT IS AND IS NOT RETRIED ──────────────────────────────────────────────
 * Only TRANSIENT-matching errors retry at all. A constraint violation, a syntax
 * error, a 401 — anything else throws on the FIRST attempt, exactly as before.
 * A longer budget buys a wrong query nothing.
 *
 * Exhaustion still throws, so a genuinely sustained outage still stops the run
 * rather than being silently swallowed. And a sustained outage is ANNOUNCED:
 * ops is alerted once the retries pass a minute, again when the budget is spent,
 * and again on recovery. While the DATABASE is what is down, these never touch
 * the alert ledger (alertOps / postResolvedNoLedger), so they still go out;
 * for Mailgun and NM OS they thread in #ops-alerts like every other alert.
 */

export const TRANSIENT =
  /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|Connection terminated|timeout|UND_ERR|Connect Timeout|aborted/i

/**
 * Errors that prove the request NEVER REACHED Mailgun — the connection was not
 * established, or DNS never resolved. Only these make a SEND safe to retry.
 *
 * This distinction is the whole reason sends were left un-retried originally,
 * and the reasoning was right: a failure *after* the request went out is
 * ambiguous, because Mailgun may have accepted the message and lost the
 * response, and re-sending would deliver the same announcement twice to a real
 * person — which cannot be taken back. A connect timeout carries no such doubt:
 * nothing was ever transmitted, so nothing can have been delivered.
 */
export const PRE_DELIVERY =
  /UND_ERR_CONNECT_TIMEOUT|Connect Timeout|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/i

// 25 attempts: 1s, 2s, 4s, 8s, 16s, then 30s a time — about 10 minutes of wall
// clock. Chosen against what is actually being waited on: a laptop's network
// dropping (sleep, a wifi change, a DNS hiccup) resolves in seconds to a few
// minutes, while an outage genuinely longer than ten minutes is not a blip and a
// person should hear about it. The pacing cost of being wrong is nil — the loop
// already spends 30s+ between messages.
export const RETRY_ATTEMPTS = 25
/** Alert once the outage is clearly not a blip — after the 1+2+4+8+16s ramp. */
export const RETRY_ALERT_AFTER = 6
const BUDGET_SEC = 601

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Which subsystem is being waited on — only used to word the alerts. */
export type RetryKind = 'database' | 'Mailgun' | 'NM OS'

export async function withTransientRetry<T>(
  kind: RetryKind,
  label: string,
  fn: () => Promise<T>,
  attempts = RETRY_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown
  let alerted = false
  const startedAt = Date.now()
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await fn()
      if (alerted) {
        const sec = Math.round((Date.now() - startedAt) / 1000)
        const text = `${kind} is back after ${sec < 90 ? `${sec} seconds` : `${Math.round(sec / 60)} minutes`}; the campaign carried on.`
        if (kind === 'database') await postResolvedNoLedger(`Campaign can't reach ${kind}`, text)
        else await resolveAlert(`campaign-unreachable:${kind}`, text)
      }
      return out
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error
        ? `${e.message} ${String((e as { sourceError?: unknown }).sourceError ?? '')} ${String((e as { cause?: unknown }).cause ?? '')}`
        : String(e)
      if (!TRANSIENT.test(msg)) throw e          // a real error is not a blip
      if (i === attempts - 1) break
      if (i === RETRY_ALERT_AFTER && !alerted) {
        alerted = true
        const a: OpsAlert = {
          severity: 'warn',
          headline: `Campaign can't reach ${kind}`,
          lines: [`Sending is paused while Disco retries for up to ${Math.round(BUDGET_SEC / 60)} minutes. Nothing to do yet.`],
          context: { label, error: shortError(msg), elapsedSec: Math.round((Date.now() - startedAt) / 1000) },
        }
        if (kind === 'database') await alertOps(a)
        else await alertOnce(`campaign-unreachable:${kind}`, a)
      }
      const backoff = Math.min(1000 * 2 ** i, 30_000) + Math.floor(Math.random() * 1000)
      console.warn(`[campaign] ${label} failed (${msg.slice(0, 90)}) — retry ${i + 1}/${attempts - 1} in ${Math.round(backoff / 1000)}s`)
      await sleep(backoff)
    }
  }
  const mins = Math.round((Date.now() - startedAt) / 60000)
  const stopped: OpsAlert = {
    severity: 'urgent',
    headline: `Campaign stopped — can't reach ${kind}`,
    lines: [`Gave up after ${mins} minutes, so the campaign has stopped.`],
    action: "relaunch it once it's reachable; recipients already sent to are skipped.",
    context: { label, attempts },
  }
  // A reply in the outage's thread when there is one; top-level when the
  // database is what's down, or no thread was ever opened.
  const replied = kind !== 'database' && await replyToAlert(`campaign-unreachable:${kind}`, 'stopped',
    `Gave up after ${mins} minutes, so the campaign has stopped.`,
    { broadcast: true, severity: 'urgent', action: stopped.action })
  if (!replied) await alertOps(stopped)
  throw lastErr
}
