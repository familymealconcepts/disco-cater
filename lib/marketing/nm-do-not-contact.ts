import { withTransientRetry } from './transient-retry'

/**
 * NM OS's do-not-contact list, asked for by the bulk campaign senders.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The one do-not-contact list lives in noise-machine (`contact_suppressions`),
 * and this repo's database cannot see it. Until 2026-10-16 the campaign scripts
 * excluded only what this database knew (marketing_email_opt_outs, disabled
 * customers, operators) plus a hand-exported /tmp file, and the rebrand script
 * not even the opt-outs. Their only protection from NM's list was Mailgun's
 * unsubscribe lists at send time. Mailgun stays as the backup; this is now the
 * first layer.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 * POST the candidate addresses to NM OS's check route and drop what comes back
 * blocked. NM OS decides which suppressions block a campaign (path
 * 'marketing_campaign' in its doNotContact.ts: all, marketing_email,
 * cold_outbound), so no rule and no copy of the list lives here. The
 * marketplace opt-outs are imported into NM OS nightly, so asking NM OS covers
 * them too.
 *
 * ── IT FAILS CLOSED ─────────────────────────────────────────────────────────
 * Anything but a well-formed 200 THROWS: a missing secret, a 401/503/500, a
 * malformed body, or `activeSuppressions === 0` (which means the wrong database
 * answered, not that nobody is suppressed). Callers let it propagate, so a run
 * refuses to start rather than sending without the check.
 *
 * Env: DNC_CHECK_SECRET (same value as NM OS's Vercel env), and optionally
 * NM_DNC_CHECK_URL to point somewhere other than production.
 */

export const NM_DNC_CHECK_URL_DEFAULT = 'https://dashboard.discocater.com/api/webhooks/do-not-contact/check'
/** NM OS accepts at most 50,000 per request; stay well under it. */
const CHUNK = 20_000

export class NmDoNotContactUnavailable extends Error {
  constructor(message: string) {
    super(`NM OS do-not-contact check unavailable — refusing to send: ${message}`)
    this.name = 'NmDoNotContactUnavailable'
  }
}

type CheckResponse = { blocked: string[]; checked: number; activeSuppressions: number }

/** Validates one response body. Pure, so the guard test pins it. */
export function parseCheckResponse(status: number, body: unknown, sent: number): CheckResponse {
  if (status !== 200) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new NmDoNotContactUnavailable(`HTTP ${status}${err ? ` (${err})` : ''}`)
  }
  const b = body as Partial<CheckResponse> | null
  if (!b || !Array.isArray(b.blocked) || !b.blocked.every((e) => typeof e === 'string')
    || typeof b.checked !== 'number' || typeof b.activeSuppressions !== 'number') {
    throw new NmDoNotContactUnavailable('malformed response')
  }
  if (b.checked !== sent) throw new NmDoNotContactUnavailable(`checked ${b.checked} of ${sent} addresses`)
  if (b.activeSuppressions <= 0) {
    throw new NmDoNotContactUnavailable('NM OS reports zero active suppressions — that is the wrong database, not an empty list')
  }
  return b as CheckResponse
}

const norm = (e: string) => e.trim().toLowerCase()

/**
 * The subset of `emails` NM OS says must not receive a campaign, lowercased.
 * Throws NmDoNotContactUnavailable on any failure; never returns a partial answer.
 */
export async function nmBlockedEmails(emails: string[]): Promise<{ blocked: Set<string>; activeSuppressions: number }> {
  const secret = process.env.DNC_CHECK_SECRET
  if (!secret) throw new NmDoNotContactUnavailable('DNC_CHECK_SECRET is not set')
  const url = process.env.NM_DNC_CHECK_URL || NM_DNC_CHECK_URL_DEFAULT
  const unique = [...new Set(emails.map(norm).filter(Boolean))]
  const blocked = new Set<string>()
  let activeSuppressions = 0
  // An empty list still makes one call, so a misconfigured run fails here rather than later.
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK))
  if (!chunks.length) chunks.push([])
  for (const chunk of chunks) {
    // Transient network errors retry (the same helper the campaign uses for its
    // database and Mailgun reads); exhaustion throws and the run stops.
    const { status, body } = await withTransientRetry('NM OS', 'do-not-contact check', async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: chunk }),
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    })
    const parsed = parseCheckResponse(status, body, chunk.length)
    for (const e of parsed.blocked) blocked.add(norm(e))
    activeSuppressions = parsed.activeSuppressions
  }
  return { blocked, activeSuppressions }
}

/**
 * Holds NM OS's answer for one campaign run and refreshes it, because a run can
 * last days (diner-announce-oct is ~115 hours of wall clock) and someone can be
 * suppressed in the middle of it. A refresh that fails throws, which stops the
 * run the same way an exhausted database retry does.
 */
export class NmDoNotContactGuard {
  private blocked = new Set<string>()
  private checkedAt = 0
  constructor(private readonly emails: string[], private readonly refreshMs = 30 * 60_000) {}

  async load(): Promise<number> {
    const r = await nmBlockedEmails(this.emails)
    this.blocked = r.blocked
    this.checkedAt = Date.now()
    return r.activeSuppressions
  }

  async isBlocked(email: string): Promise<boolean> {
    if (Date.now() - this.checkedAt >= this.refreshMs) await this.load()
    return this.blocked.has(norm(email))
  }

  get size(): number {
    return this.blocked.size
  }
}
