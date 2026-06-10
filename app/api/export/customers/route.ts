import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// Read-only customer export for CRM sync. API-key protected. Pages through FM's
// platform-wide customer list, then joins the platform-wide order list (same
// source as /api/export/orders) on customer email to enrich each customer with
// order-derived metrics (total orders, lifetime value, AOV, first/last order).

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

// Normalize an email for case-insensitive joining (null when absent).
function normEmail(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null
}

// Pull the customer email off an order row (same precedence as /api/export/orders).
function orderEmail(o: FmRow): string | null {
  const customer = o.customer as FmRow | undefined
  const saleCustomer = (o.saleTransaction as FmRow | undefined)?.customer as FmRow | undefined
  return normEmail(customer?.email ?? saleCustomer?.email ?? o.userEmail ?? o.customerEmail ?? o.email)
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

export async function GET(request: Request) {
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const headerRef = { h: await getFmServiceAuthHeader() }

    // 1) All customers.
    const customersRaw = await fetchAllFmPages(
      (page, size) => `${FM}/api/customer/users?${new URLSearchParams({ page: String(page), size: String(size) })}`,
      headerRef,
    )

    // 2) All orders in the same 365-day window /api/export/orders uses.
    const fromDate = fromDate365()
    const ordersRaw = await fetchAllFmPages(
      (page, size) => `${FM}/api/admin/userOrders?${new URLSearchParams({ page: String(page), size: String(size), fromDate })}`,
      headerRef,
    )

    // 3) Aggregate orders by customer email.
    const stats = new Map<string, OrderStats>()
    for (const o of ordersRaw) {
      const email = orderEmail(o)
      if (!email) continue
      const subtotal = num(o.subtotal) ?? 0
      const ts = o.orderDate != null ? Date.parse(String(o.orderDate)) : NaN

      const s = stats.get(email) ?? { count: 0, lifetime: 0, minTs: null, maxTs: null }
      s.count += 1
      s.lifetime += subtotal
      if (Number.isFinite(ts)) {
        if (s.minTs === null || ts < s.minTs) s.minTs = ts
        if (s.maxTs === null || ts > s.maxTs) s.maxTs = ts
      }
      stats.set(email, s)
    }

    // 4) Join onto each customer and compute the derived fields.
    const customers = customersRaw.map((c) => {
      const email = (c.email as string | null) ?? null
      const s = email ? stats.get(normEmail(email) ?? '') : undefined
      const totalOrders = s?.count ?? 0
      const lifetimeValue = round2(s?.lifetime ?? 0)
      const averageOrderValue = totalOrders > 0 ? round2(lifetimeValue / totalOrders) : 0
      return {
        email,
        firstName: (c.firstName as string | null) ?? null,
        lastName: (c.lastName as string | null) ?? null,
        totalOrders,
        lifetimeValue,
        averageOrderValue,
        firstOrderDate: s?.minTs != null ? new Date(s.minTs).toISOString() : null,
        lastOrderDate: s?.maxTs != null ? new Date(s.maxTs).toISOString() : null,
      }
    })

    return NextResponse.json(customers, { headers: { 'X-Total-Count': String(customers.length) } })
  } catch (e) {
    console.error('[export/customers] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export customers' }, { status: 500 })
  }
}
