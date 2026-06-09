import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// Read-only order export for CRM sync (last 365 days). API-key protected. Pages
// through FM's platform-wide order list using the service account.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

type FmRow = Record<string, unknown>

// 365 days ago as DD.MM.YYYY (FM's expected date format).
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

export async function GET(request: Request) {
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const fromDate = fromDate365()
    const SIZE = 200
    const MAX_PAGES = 200
    const all: FmRow[] = []
    let header = await getFmServiceAuthHeader()
    let page = 0
    let totalPages = 1
    let retried = false

    while (page < totalPages && page < MAX_PAGES) {
      const params = new URLSearchParams({ page: String(page), size: String(SIZE), fromDate })
      const res = await fetch(`${FM}/api/admin/userOrders?${params}`, { headers: header, cache: 'no-store' })
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

    // One-time visibility into FM's actual order shape so we can confirm where
    // the customer email/name actually live (customer.*, saleTransaction.customer.*, …).
    if (all.length > 0) {
      console.log('[Export Orders] Sample raw order:', JSON.stringify(all[0], null, 2))
    }

    const orders = all.map((o) => {
      const customer = o.customer as FmRow | undefined
      const saleCustomer = (o.saleTransaction as FmRow | undefined)?.customer as FmRow | undefined
      // Prefer nested customer first/last, then any top-level first/last, then a userName string.
      const nestedName = [customer?.firstName, customer?.lastName].filter(Boolean).join(' ')
      const topName = [o.firstName, o.lastName].filter(Boolean).join(' ')
      const customerName = nestedName || topName || (o.userName as string | undefined) || null
      return {
        orderRef: o.orderReference ?? o.reference ?? null,
        orderNumber: o.orderNumber ?? null,
        customerEmail: customer?.email ?? saleCustomer?.email ?? o.userEmail ?? o.customerEmail ?? o.email ?? null,
        customerName,
        restaurantName: o.restaurantName ?? null,
        restaurantReference: o.restaurantReference ?? null,
        orderDate: o.orderDate ?? null,
        orderType: o.orderType ?? null,
        sourceOfOrder: o.sourceoforder ?? o.sourceOfOrder ?? null,
        subtotal: num(o.subtotal),
        total: num(o.total ?? o.transactionsTotal),
        orderStatus: o.orderStatus ?? o.status ?? null,
        tips: num(o.tips),
        deliveryFee: num(o.deliveryFee),
      }
    })

    return NextResponse.json(orders, { headers: { 'X-Total-Count': String(orders.length) } })
  } catch (e) {
    console.error('[export/orders] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export orders' }, { status: 500 })
  }
}
