// What an #ops-alerts message says, and nothing about how it is sent. Pure, so
// scripts/tests/ops-alert-format.test.ts can pin every rule without a database.
//
// THE SHAPE, approved word for word by Kevin 2026-10-23:
//
//   :rotating_light: *Plain headline — order #900000463*
//   Who/what is affected, one line per fact
//   What happened, in words
//   *What to do:* the action
//   <url|Open order #900000463 in NM OS>
//
// NO RAW JSON EVER REACHES SLACK. The structured context an alert carries goes to
// the Vercel log under [OPS-ALERT] and nowhere else. Before this, every message
// was `[OPS-ALERT] <code text> {json}`, and one order posted 61 of them.

export type OpsSeverity = 'urgent' | 'warn' | 'email'

export type OpsAlert = {
  headline: string
  severity?: OpsSeverity
  /** Body lines, in order: who/what is affected, then what happened. */
  lines?: string[]
  /** Rendered as "*What to do:* …". */
  action?: string
  link?: { url: string; label: string }
  /** Vercel log only. Never rendered into the Slack text. */
  context?: Record<string, unknown>
}

const EMOJI: Record<OpsSeverity, string> = {
  urgent: ':rotating_light:',
  warn: ':warning:',
  email: ':envelope:',
}

export const RESOLVED_EMOJI = ':white_check_mark:'

/** Slack mrkdwn escaping: only these three characters are control characters in message text. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderAlert(a: OpsAlert): string {
  const out: string[] = [`${EMOJI[a.severity ?? 'warn']} *${slackEscape(a.headline)}*`]
  for (const l of a.lines ?? []) if (l && l.trim()) out.push(slackEscape(l))
  if (a.action) out.push(`*What to do:* ${slackEscape(a.action)}`)
  if (a.link) out.push(`<${a.link.url}|${slackEscape(a.link.label)}>`)
  return out.join('\n')
}

/** A thread reply: "✅ Resolved: …" or an escalation line. Same escaping as the parent. */
export function renderReply(text: string, opts?: { resolved?: boolean; severity?: OpsSeverity; action?: string }): string {
  const lead = opts?.resolved ? `${RESOLVED_EMOJI} ` : opts?.severity ? `${EMOJI[opts.severity]} ` : ''
  return `${lead}${slackEscape(text)}${opts?.action ? ` *What to do:* ${slackEscape(opts.action)}` : ''}`
}

/**
 * The no-thread fallback (no bot token): a resolve can't reply in a thread, so
 * it posts top-level and names the alert it closes.
 */
export function renderTopLevelResolve(headline: string | null, text: string): string {
  return headline
    ? `${RESOLVED_EMOJI} *${slackEscape(headline)}*\n${slackEscape(text)}`
    : `${RESOLVED_EMOJI} ${slackEscape(text)}`
}

// ── Links ─────────────────────────────────────────────────────────────────────
// NM OS is where these get worked: an order alert opens the order there, a
// restaurant alert opens the Suggestion Box section that owns it. The box has no
// link-by-key, and disco-cater cannot know NM OS suggestion ids.
const NM_OS = 'https://dashboard.discocater.com'

export function orderLink(reference: string, orderNumber?: string | null): { url: string; label: string } {
  return { url: `${NM_OS}/orders/${reference}`, label: `Open order ${orderNumber ? `#${orderNumber}` : reference} in NM OS` }
}

export const SUGGESTIONS = {
  accountManagement: { url: `${NM_OS}/tasks/suggestions?section=restaurants`, label: 'Account Management suggestions' },
  diners: { url: `${NM_OS}/tasks/suggestions?section=diners`, label: 'Diners suggestions' },
  omakase: { url: `${NM_OS}/tasks/suggestions?section=omakase`, label: 'Omakase suggestions' },
} as const

// ── Money and times ───────────────────────────────────────────────────────────

export function money(n: number | string | null | undefined): string {
  const v = n == null || n === '' ? NaN : Number(n)
  if (!Number.isFinite(v)) return '$?'
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * "Tue Oct 21, 8:30 AM PDT" in the RESTAURANT's zone. A restaurant in Los
 * Angeles and its diner both mean Pacific; a reader in New York needs the
 * label to know it isn't their 8:30.
 */
export function formatWhen(at: Date | string | null | undefined, timeZone?: string | null, opts?: { dateOnly?: boolean }): string {
  if (!at) return ''
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const tz = timeZone && timeZone.trim() ? timeZone : 'America/New_York'
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      ...(opts?.dateOnly ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    }).formatToParts(d)
  } catch {
    return formatWhen(d, 'America/New_York', opts)
  }
  const p = (t: string) => parts.find(x => x.type === t)?.value ?? ''
  const date = `${p('weekday')} ${p('month')} ${p('day')}`
  if (opts?.dateOnly) return date
  return `${date}, ${p('hour')}:${p('minute')} ${p('dayPeriod')} ${p('timeZoneName')}`
}

/** A calendar day stored as YYYY-MM-DD, rendered "Sat Oct 25" with no zone conversion. */
export function formatDay(day: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''))
  if (!m) return ''
  return formatWhen(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), 'UTC', { dateOnly: true })
}

/** Error text for a message body: one line, bounded, never a JSON blob. */
export function shortError(e: unknown, max = 120): string {
  let s = e instanceof Error ? e.message : String(e ?? '')
  // A JSON body ({"message": "..."}) — say its message, not its braces.
  const json = /\{[\s\S]*\}/.exec(s)
  if (json) {
    try {
      const o = JSON.parse(json[0]) as Record<string, unknown>
      const inner = o.message ?? o.error ?? o.detail
      if (typeof inner === 'string') s = s.replace(json[0], inner)
    } catch { /* not JSON after all */ }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ── Order email not delivered ─────────────────────────────────────────────────

export type EmailSide = 'diner' | 'restaurant' | 'unknown'

/**
 * Whose copy bounced. The SUBJECT decides first, because the two templates in
 * lib/email/notifications.ts differ: the diner's receipt is
 * "New Disco Cater Order — {business} #{n}", the restaurant's notification is
 * "{business} — Order {n} ($…)". The recipient only breaks a tie: a diner who
 * later corrected their address no longer matches customer_email, but the
 * subject still says diner (#900000476).
 */
export function emailSide(input: {
  subject?: string | null
  recipient: string
  orderNumber: string
  customerEmail?: string | null
  restaurantEmails?: Array<string | null | undefined>
}): EmailSide {
  const subject = String(input.subject ?? '')
  const n = input.orderNumber
  if (/^New Disco Cater Order\b/i.test(subject)) return 'diner'
  if (n && subject.includes(` — Order ${n} `)) return 'restaurant'
  if (n && subject.endsWith(` — Order ${n}`)) return 'restaurant'
  const r = input.recipient.trim().toLowerCase()
  if (r && input.customerEmail && r === input.customerEmail.trim().toLowerCase()) return 'diner'
  if (r && (input.restaurantEmails ?? []).some(e => String(e ?? '').split(/[,;\s]+/).some(x => x.trim().toLowerCase() === r))) return 'restaurant'
  return 'unknown'
}

/**
 * A diner's address is shown as "…@domain" only (Kevin, 2026-10-23). The domain
 * is what the reader needs — "gmail.con" is the typo — and the mailbox is
 * personal data the channel doesn't need. Restaurant and admin business
 * addresses are shown in full.
 */
export function maskDinerEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return at >= 0 ? `…${email.slice(at)}` : '…'
}

/** Mailgun's delivery-status text, said in words. */
export function bounceReason(reason: string, recipient: string): string {
  const domain = recipient.includes('@') ? recipient.slice(recipient.lastIndexOf('@') + 1) : ''
  const r = reason || ''
  if (/no MX|no such host|NXDOMAIN|domain.*(not found|does not exist)/i.test(r)) {
    return `It bounced because ${domain || 'the domain'} doesn't exist (likely a typo).`
  }
  if (/RBL|JunkMail|spam|blocklist|blacklist/i.test(r)) {
    return 'Their mail server blocked it as spam (our sending server was on a blocklist).'
  }
  if (/mailbox (unavailable|not found|does not exist)|user unknown|no such user|recipient.*(unknown|not found|rejected)|5\.1\.1/i.test(r)) {
    return "That mailbox doesn't exist."
  }
  if (/\b550\b|blocked|refused|rejected|denied/i.test(r)) {
    return 'Their mail server refused it.'
  }
  return `Mailgun said: "${shortError(r)}"`
}

// ── Transient failures ────────────────────────────────────────────────────────
// Kevin, 2026-10-23: a scheduled job alerts only after it has failed this many
// runs IN A ROW. Measured against #ops-alerts: at 3 for the 5–15-minute jobs,
// the single Mailgun 500 on 10-23 and all seven single admin-list failures since
// 09-24 post nothing, and the 09-19 FamilyMeal outage posts once instead of ~60
// times. Daily jobs alert on the first failure: one miss is already a day stale.

export type JobInfo = { name: string; meaning: string; threshold: number; fix?: string }

export const JOBS: Record<string, JobInfo> = {
  'mailgun-failures': { name: 'Bounced-email check', meaning: "Bounced order emails aren't being picked up while this is down.", threshold: 3, fix: "check Mailgun's status page" },
  'refresh-restaurant-admin-list': { name: 'Restaurant admin list refresh', meaning: "The Super Admin restaurant list is going stale (FamilyMeal isn't answering).", threshold: 3, fix: 'check whether FamilyMeal is up' },
  'mirror-online-ordering': { name: 'Online-ordering mirror', meaning: "Online-ordering settings aren't being copied from FamilyMeal.", threshold: 3 },
  'check-bare-orders': { name: 'Missing-items check', meaning: "Orders missing their line items aren't being looked for.", threshold: 2 },
  'menu-drift-check': { name: 'Menu check', meaning: "Menu differences with FamilyMeal aren't being checked.", threshold: 1 },
  'reconcile-money-flow': { name: 'Money-flow check', meaning: "Money-flow settings aren't being checked.", threshold: 1 },
  'reconcile-promo-codes': { name: 'Promo-code check', meaning: "Promo codes aren't being checked against FamilyMeal.", threshold: 1 },
  'reconcile-stripe-links': { name: 'Stripe link check', meaning: "Converted restaurants aren't being linked to Stripe.", threshold: 1 },
  'refresh-map-cache': { name: 'Marketplace map refresh', meaning: 'The public marketplace map is going stale.', threshold: 1 },
  'refresh-stripe-capabilities': { name: 'Stripe status refresh', meaning: "New Stripe restrictions aren't being picked up.", threshold: 2 },
  'retry-expedite-dispatch': { name: 'Courier retry', meaning: "Orders with no courier aren't being retried.", threshold: 2 },
  'sync-restaurants': { name: 'Restaurant sync (Sanity)', meaning: "New and changed restaurants aren't reaching the site.", threshold: 1 },
  'sync-fm-orders': { name: 'FamilyMeal order sync', meaning: "FamilyMeal orders aren't reaching Disco.", threshold: 2 },
  'check-fm-order-gaps': { name: 'FamilyMeal order gap check', meaning: "Missing FamilyMeal orders aren't being looked for.", threshold: 1 },
  'fm-order-watch': { name: 'FamilyMeal order watch', meaning: "Converted restaurants' FamilyMeal orders aren't being watched.", threshold: 2 },
  // "Could not save its progress" — the job ran but its cursor/state write failed.
  'sync-fm-orders:cursor': { name: 'FamilyMeal order sync (saving its place)', meaning: 'The sync will repeat the same restaurants instead of moving on.', threshold: 2 },
  'sync-restaurants:cursor': { name: 'Restaurant sync (saving its place)', meaning: 'The sync will repeat the same window next run.', threshold: 2 },
  'reconcile-stripe-links:state': { name: 'Stripe link check (saving its state)', meaning: 'The next run will report the same restaurants again.', threshold: 2 },
  'campaign-health-poll': { name: 'Campaign health check', meaning: 'The running campaign is being judged on an older health snapshot.', threshold: 3 },
}

export function jobFailureAlert(job: string, failures: number, lastError: string): OpsAlert {
  const j = JOBS[job] ?? { name: job, meaning: '', threshold: 1 }
  return {
    severity: 'warn',
    headline: failures > 1 ? `${j.name} has failed ${failures} runs in a row` : `${j.name} failed`,
    lines: [`${j.meaning}${j.meaning ? ' ' : ''}Last error: "${shortError(lastError)}".`],
    action: `nothing if it recovers on its own; if it's still failing in an hour, ${j.fix ?? 'check its cron log in Vercel'}.`,
  }
}

/** "5:25 AM" in the site zone, for the "Recovered: it ran fine at …" reply. */
export function clockTime(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(at)
}

export function jobRecoveredText(failures: number, at: Date): string {
  return `Recovered: it ran fine at ${clockTime(at)} after ${failures} failure${failures === 1 ? '' : 's'}.`
}

/** A campaign auto-halt reason from lib/marketing/campaign-health.ts, said as a sentence. */
export function haltReasonInWords(reason: string): string {
  const roll = /^(hard bounces|spam complaints) ([\d.]+)% over the last (\d+) sends .*limit ([\d.]+)%\)$/i.exec(reason)
  if (roll) {
    const what = roll[1].toLowerCase() === 'hard bounces' ? 'Bounces' : 'Spam complaints'
    return `${what} hit ${Number(roll[2])}% of the last ${Number(roll[3]).toLocaleString('en-US')} sent (the limit is ${Number(roll[4])}%).`
  }
  const del = /^delivery ([\d.]+)% of (\d+) matured sends \(floor ([\d.]+)%\)$/i.exec(reason)
  if (del) return `Only ${Number(del[1])}% of ${Number(del[2]).toLocaleString('en-US')} sent were delivered (the floor is ${Number(del[3])}%).`
  const fails = /^(\d+) consecutive send failures \(limit (\d+)\)$/i.exec(reason)
  if (fails) return `${fails[1]} sends in a row failed (the limit is ${fails[2]}).`
  const s = shortError(reason, 160)
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`
}
