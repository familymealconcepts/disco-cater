import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// Read-only customer export for CRM sync. API-key protected. Pages through FM's
// platform-wide customer list using the service account.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

type FmRow = Record<string, unknown>

export async function GET(request: Request) {
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const SIZE = 200
    const MAX_PAGES = 200
    const all: FmRow[] = []
    let header = await getFmServiceAuthHeader()
    let page = 0
    let totalPages = 1
    let retried = false

    while (page < totalPages && page < MAX_PAGES) {
      const params = new URLSearchParams({ page: String(page), size: String(SIZE) })
      const res = await fetch(`${FM}/api/customer/users?${params}`, { headers: header, cache: 'no-store' })
      if (res.status === 401 && !retried) {
        retried = true
        header = await getFmServiceAuthHeader(true)
        continue
      }
      if (!res.ok) break
      const d = await res.json().catch(() => null)
      const content: FmRow[] = Array.isArray(d?.content) ? d.content : Array.isArray(d) ? d : []
      all.push(...content)
      totalPages = typeof d?.totalPages === 'number' ? d.totalPages : 1
      page++
    }

    const customers = all.map((c) => ({
      id: c.id ?? null,
      email: c.email ?? null,
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      phoneNumber: c.phoneNumber ?? null,
      createdDate: c.createdDate ?? null,
      lastOrderDate: c.lastOrderDate ?? null,
      totalOrders: c.totalOrders ?? null,
      role: c.role ?? null,
    }))

    return NextResponse.json(customers, { headers: { 'X-Total-Count': String(customers.length) } })
  } catch (e) {
    console.error('[export/customers] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export customers' }, { status: 500 })
  }
}
