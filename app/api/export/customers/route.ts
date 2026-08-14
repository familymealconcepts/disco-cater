import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'
import { sql } from '../../../../lib/db'
import { PLACEHOLDER_EMAIL_SQL_PATTERN, normalizeEmail } from '../../../../lib/customer-email-guard'

// Read-only customer export for CRM sync. API-key protected.
//
// Roster source: disco_customer_roster (lib/fm-customer-sync.ts), a mirror of
// FM's platform-wide customer list kept current by a daily cron — NOT a live
// FM pull on every call anymore (that was 85 pages, ~32s, every single time
// this was hit). Pass ?source=fm to force the original live-FM-pull path
// instead — kept as a fallback until the mirror's output is confirmed to
// match; not deleted in this change, per instruction.
//
// Either way, order-derived metrics (total orders, lifetime value, AOV,
// first/last order) are unchanged — computed from disco_orders (Neon-first,
// FM-list fallback), joined by normalized email, exactly as before.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

type FmRow = Record<string, unknown>

// 365 days ago as DD.MM.YYYY (FM's expected date format) — matches the window
// /api/export/orders uses, so the join sees the same order set.
function fromDate365(): string {
  const d = new Date(Date.now() - 365 * 86_400_000)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${dd}.${mm}.${yyyy}`
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Pull the customer email off an order row (same precedence as /api/export/orders).
function orderEmail(o: FmRow): string | null {
  const customer = o.customer as FmRow | undefined
  const saleCustomer = (o.saleTransaction as FmRow | undefined)?.customer as FmRow | undefined
  return normalizeEmail(customer?.email ?? saleCustomer?.email ?? o.userEmail ?? o.customerEmail ?? o.email)
}

// Page through an FM list endpoint, refreshing the service token once on 401.
// `headerRef.h` is mutated in place so a refreshed token carries to later pages
// and to subsequent calls that share the same ref.
async function fetchAllFmPages(
  url: (page: number, size: number) => string,
  headerRef: { h: Record<string, string> },
): Promise<FmRow[]> {
  const SIZE = 200
  const MAX_PAGES = 200
  const all: FmRow[] = []
  let page = 0
  let totalPages = 1
  let retried = false
  while (page < totalPages && page < MAX_PAGES) {
    const res = await fetch(url(page, SIZE), { headers: headerRef.h, cache: 'no-store' })
    if (res.status === 401 && !retried) {
      retried = true
      headerRef.h = await getFmServiceAuthHeader(true)
      continue
    }
    if (!res.ok) break
    const d = await res.json().catch(() => null)
    const content: FmRow[] = Array.isArray(d?.content) ? d.content : Array.isArray(d) ? d : []
    all.push(...content)
    totalPages = typeof d?.totalPages === 'number' ? d.totalPages : 1
    page++
  }
  return all
}

interface OrderStats {
  count: number
  lifetime: number
  minTs: number | null
  maxTs: number | null
}

// Accumulate one (email, subtotal, date) order row into the stats map.
function accumulate(stats: Map<string, OrderStats>, email: string | null, subtotalRaw: unknown, dateRaw: unknown): void {
  if (!email) return
  const subtotal = num(subtotalRaw) ?? 0
  const ts = dateRaw != null ? Date.parse(String(dateRaw)) : NaN
  const s = stats.get(email) ?? { count: 0, lifetime: 0, minTs: null, maxTs: null }
  s.count += 1
  s.lifetime += subtotal
  if (Number.isFinite(ts)) {
    if (s.minTs === null || ts < s.minTs) s.minTs = ts
    if (s.maxTs === null || ts > s.maxTs) s.maxTs = ts
  }
  stats.set(email, s)
}

// Primary source: Disco-native orders in Neon. subtotal lives on the ORIGINAL
// sale transaction (disco_orders has no subtotal column), so LEFT JOIN it.
async function statsFromNeon(): Promise<Map<string, OrderStats>> {
  const rows = (await sql`
    SELECT o.customer_email, o.order_date, t.subtotal
    FROM disco_orders o
    LEFT JOIN disco_sale_transactions t
      ON t.order_id = o.id AND t.transaction_type = 'ORIGINAL'
    WHERE o.created_at > NOW() - INTERVAL '365 days'
      AND o.customer_email IS NOT NULL
      AND o.customer_email NOT LIKE ${PLACEHOLDER_EMAIL_SQL_PATTERN}
      AND o.is_deleted = false
  `) as FmRow[]
  const stats = new Map<string, OrderStats>()
  for (const r of rows) accumulate(stats, normalizeEmail(r.customer_email), r.subtotal, r.order_date)
  return stats
}

// Fallback source: FM's platform-wide order list (same window/precedence as
// /api/export/orders). Used only if the Neon query fails.
async function statsFromFm(headerRef: { h: Record<string, string> }): Promise<Map<string, OrderStats>> {
  const fromDate = fromDate365()
  const ordersRaw = await fetchAllFmPages(
    (page, size) => `${FM}/api/admin/userOrders?${new URLSearchParams({ page: String(page), size: String(size), fromDate })}`,
    headerRef,
  )
  const stats = new Map<string, OrderStats>()
  for (const o of ordersRaw) accumulate(stats, orderEmail(o), o.subtotal, o.orderDate)
  return stats
}

interface RosterEntry { email: string | null; firstName: string | null; lastName: string | null }

// Default source: the Neon mirror (lib/fm-customer-sync.ts), kept current by
// the daily cron. Excludes anything soft-deleted (no longer on FM).
async function rosterFromMirror(): Promise<RosterEntry[]> {
  const rows = (await sql`
    SELECT email, first_name, last_name FROM disco_customer_roster WHERE removed_from_fm_at IS NULL
  `) as { email: string; first_name: string | null; last_name: string | null }[]
  return rows.map(r => ({ email: r.email, firstName: r.first_name, lastName: r.last_name }))
}

// Fallback source: FM's live customer list, exactly as this export worked
// before the mirror existed (same fields read, same shape — including that
// firstName/lastName are read from fields this endpoint doesn't actually
// have, so they come back null here, same as always). Kept verbatim for a
// side-by-side comparison against the mirror, not modernized — this is the
// known-behavior baseline, not a second implementation to maintain.
async function rosterFromFm(headerRef: { h: Record<string, string> }): Promise<RosterEntry[]> {
  const customersRaw = await fetchAllFmPages(
    (page, size) => `${FM}/api/customer/users?${new URLSearchParams({ page: String(page), size: String(size) })}`,
    headerRef,
  )
  return customersRaw.map(c => ({
    email: (c.email as string | null) ?? null,
    firstName: (c.firstName as string | null) ?? null,
    lastName: (c.lastName as string | null) ?? null,
  }))
}

export async function GET(request: Request) {
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const useFm = url.searchParams.get('source') === 'fm'

  try {
    // headerRef is only ever needed for an FM call — the roster-from-FM
    // fallback, or the stats-from-FM fallback if the Neon stats query fails.
    // Lazy so the common case (mirror roster + Neon stats) never logs into FM.
    let headerRefCache: { h: Record<string, string> } | null = null
    const getHeaderRef = async () => {
      if (!headerRefCache) headerRefCache = { h: await getFmServiceAuthHeader() }
      return headerRefCache
    }

    const roster = useFm ? await rosterFromFm(await getHeaderRef()) : await rosterFromMirror()

    // Aggregate orders by customer email. Prefer Neon (disco_orders); fall
    // back to the FM order list if the query fails so this never breaks.
    let stats: Map<string, OrderStats>
    try {
      stats = await statsFromNeon()
    } catch (e) {
      console.error('[export/customers] Neon orders query failed, falling back to FM:', e instanceof Error ? e.message : e)
      stats = await statsFromFm(await getHeaderRef())
    }

    // Join onto each customer and compute the derived fields.
    const customers = roster.map((c) => {
      const email = c.email
      const s = email ? stats.get(normalizeEmail(email) ?? '') : undefined
      const totalOrders = s?.count ?? 0
      const lifetimeValue = round2(s?.lifetime ?? 0)
      const averageOrderValue = totalOrders > 0 ? round2(lifetimeValue / totalOrders) : 0
      return {
        email,
        firstName: c.firstName,
        lastName: c.lastName,
        totalOrders,
        lifetimeValue,
        averageOrderValue,
        firstOrderDate: s?.minTs != null ? new Date(s.minTs).toISOString() : null,
        lastOrderDate: s?.maxTs != null ? new Date(s.maxTs).toISOString() : null,
      }
    })

    return NextResponse.json(customers, { headers: { 'X-Total-Count': String(customers.length), 'X-Roster-Source': useFm ? 'fm' : 'mirror' } })
  } catch (e) {
    console.error('[export/customers] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export customers' }, { status: 500 })
  }
}
