// Mirrors FM's platform-wide customer list into disco_customer_roster so
// /api/export/customers can read Neon instead of paging FM live on every
// call (85 pages, ~32s measured). These are NOT accounts — no login, no
// password, read-only CRM roster data (email/name) plus order-derived stats
// computed separately from disco_orders.
//
// Never truncates: the full pull happens BEFORE any write, and a failed or
// partial pull leaves the table completely untouched — the export keeps
// serving the last good roster rather than an empty or half-updated one.
// Removed/merged FM records are soft-deleted (removed_from_fm_at), never
// hard-deleted, so a mismatch is diagnosable later instead of silently gone.

import { sql, runMigrations } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { normalizeEmail } from './customer-email-guard'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const PAGE_SIZE = 200

export type UsernameQuality = 'ok' | 'single-token' | 'empty' | 'email-in-name'
export interface UsernameSplit { firstName: string | null; lastName: string | null; quality: UsernameQuality }

// FM's customer list has no separate firstName/lastName field at all — just a
// single `username` string (confirmed live: e.g. " Lee Darling", leading
// space included — FM's own value, not a formatting artifact here). Heuristic
// split: first whitespace-separated token -> first_name, remainder ->
// last_name. A value containing '@' is never trusted as a name (a handful of
// real records have an email sitting in this field) — left blank rather than
// shown as a name.
export function splitUsername(raw: unknown): UsernameSplit {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { firstName: null, lastName: null, quality: 'empty' }
  if (trimmed.includes('@')) return { firstName: null, lastName: null, quality: 'email-in-name' }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0], lastName: null, quality: 'single-token' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' '), quality: 'ok' }
}

interface FmCustomerRow { username?: unknown; email?: unknown }

async function fetchAllFmCustomers(): Promise<{ rows: FmCustomerRow[]; complete: boolean; fmTotal: number }> {
  let auth = await getFmServiceAuthHeader()
  const rows: FmCustomerRow[] = []
  let page = 0
  let totalPages = 1
  let fmTotal = 0
  let retried = false
  while (page < totalPages) {
    let res: Response
    try {
      res = await fetch(`${FM}/api/customer/users?${new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) })}`, { headers: { ...auth, Accept: 'application/json' } })
    } catch (e) {
      console.error(`[fm-customer-sync] fetch threw at page ${page}/${totalPages}:`, e instanceof Error ? e.message : e)
      return { rows, complete: false, fmTotal }
    }
    if (res.status === 401 && !retried) {
      retried = true
      auth = await getFmServiceAuthHeader(true)
      continue
    }
    if (!res.ok) {
      console.error(`[fm-customer-sync] FM returned HTTP ${res.status} at page ${page}/${totalPages}`)
      return { rows, complete: false, fmTotal }
    }
    const d = await res.json().catch(() => null) as { content?: unknown; totalPages?: number; totalElements?: number } | null
    const content = Array.isArray(d?.content) ? d.content as FmCustomerRow[] : []
    rows.push(...content)
    totalPages = typeof d?.totalPages === 'number' ? d.totalPages : 1
    fmTotal = typeof d?.totalElements === 'number' ? d.totalElements : rows.length
    page++
  }
  return { rows, complete: true, fmTotal }
}

export interface FmCustomerSyncResult {
  ok: boolean
  fmTotal: number
  fetched: number
  upserted: number
  newlyRemoved: number
  mirrorTotal: number
  durationMs: number
  usernameQuality?: Record<UsernameQuality, number>
  reason?: string
}

export async function syncFmCustomers(): Promise<FmCustomerSyncResult> {
  const startedAt = Date.now()
  await runMigrations()

  const { rows, complete, fmTotal } = await fetchAllFmCustomers()
  if (!complete) {
    const reason = 'FM pull did not complete — mirror left untouched, still serving the last good roster'
    console.error(`[fm-customer-sync] ${reason} (fetched ${rows.length} before failing)`)
    return { ok: false, fmTotal, fetched: rows.length, upserted: 0, newlyRemoved: 0, mirrorTotal: -1, durationMs: Date.now() - startedAt, reason }
  }

  // Captured from Postgres, not Node's clock, so it compares cleanly against
  // the NOW() every upsert below writes to last_seen_at.
  const nowRows = (await sql`SELECT NOW() AS now`) as { now: string }[]
  const runStartedAt = nowRows[0].now

  // Last one wins on a normalized-email collision (10 groups out of 16,835
  // distinct emails, confirmed live — both inspected examples were internal
  // test accounts).
  const byEmail = new Map<string, FmCustomerRow>()
  for (const r of rows) {
    const email = normalizeEmail(r.email)
    if (!email) continue
    byEmail.set(email, r)
  }

  const usernameQuality: Record<UsernameQuality, number> = { ok: 0, 'single-token': 0, empty: 0, 'email-in-name': 0 }
  const emails: string[] = []
  const firstNames: (string | null)[] = []
  const lastNames: (string | null)[] = []
  for (const [email, r] of byEmail) {
    const split = splitUsername(r.username)
    usernameQuality[split.quality]++
    emails.push(email)
    firstNames.push(split.firstName)
    lastNames.push(split.lastName)
  }

  // Bulk upsert via unnest — one round trip per chunk instead of one per
  // customer. A naive one-row-at-a-time loop measured ~33 upserts/sec against
  // Neon's HTTP driver (~8.5 minutes for 16,835 rows), which would blow well
  // past this cron's 300s budget; chunked unnest does the same work in a
  // handful of round trips.
  const CHUNK = 2000
  let upserted = 0
  for (let i = 0; i < emails.length; i += CHUNK) {
    const emailChunk = emails.slice(i, i + CHUNK)
    const firstChunk = firstNames.slice(i, i + CHUNK)
    const lastChunk = lastNames.slice(i, i + CHUNK)
    await sql`
      INSERT INTO disco_customer_roster (email, first_name, last_name, last_seen_at, removed_from_fm_at, updated_at)
      SELECT email, first_name, last_name, NOW(), NULL, NOW()
      FROM unnest(${emailChunk}::text[], ${firstChunk}::text[], ${lastChunk}::text[]) AS t(email, first_name, last_name)
      ON CONFLICT (email) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        last_seen_at = NOW(),
        removed_from_fm_at = NULL,
        updated_at = NOW()
    `
    upserted += emailChunk.length
  }

  // Soft-delete: anything not touched by this run (still stamped before it
  // started) and not already marked. Never a hard delete or a table truncate.
  const removedRows = (await sql`
    UPDATE disco_customer_roster
    SET removed_from_fm_at = NOW(), updated_at = NOW()
    WHERE last_seen_at < ${runStartedAt} AND removed_from_fm_at IS NULL
    RETURNING id
  `) as { id: number }[]

  const mirrorCountRows = (await sql`SELECT COUNT(*)::int AS n FROM disco_customer_roster WHERE removed_from_fm_at IS NULL`) as { n: number }[]
  const mirrorTotal = mirrorCountRows[0]?.n ?? -1
  const durationMs = Date.now() - startedAt

  console.log(`[fm-customer-sync] fmTotal=${fmTotal} fetched=${rows.length} upserted=${upserted} newlyRemoved=${removedRows.length} mirrorTotal=${mirrorTotal} (${durationMs}ms)`)
  return { ok: true, fmTotal, fetched: rows.length, upserted, newlyRemoved: removedRows.length, mirrorTotal, durationMs, usernameQuality }
}
