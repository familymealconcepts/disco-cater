import { NextRequest, NextResponse } from 'next/server'
import { GET as listOrders } from '../route'
import {
  EXPORT_FORMATS, exportFileName, loadExportOrders, renderDetailsPdf, renderSummaryPdf, renderXlsx, type ExportFormat,
} from '../../../../../lib/order/order-export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// GET /api/restaurant/orders/export?format=SUMMARY|DETAILS|XLSX&tab=active|history&recurring=all|recurring|onetime
//     &<the Orders list's own query: orderStatuses, sort, search, fromDate, toDate>
//
// Export Orders (lib/order/order-export.ts). EXACTLY THE ORDERS THE TAB SHOWS: the list is read through the
// Orders list route's own handler, so scope, permissions (the same as viewing orders), the tab's statuses,
// search, dates and sort cannot differ from the screen. The two filters the page applies in the browser are
// applied here the same way: a refunded order is Active until its date passes and History after
// (isUpcomingRefunded in the orders page), and the recurring filter.

const MAX_ORDERS = 1000
const PAGE = 200
const REFUND_STATUSES = new Set(['REFUND', 'REFUNDED', 'PARTIAL_REFUND'])

type ListRow = { orderReference: string; orderStatus?: string; orderDate?: string; restaurantTimezone?: string; orderSubscription?: unknown; isRecurring?: boolean; subscriptionReference?: string; recurring?: boolean }

/** The orders page's rule, with "today" in the restaurant's own zone. */
function isUpcomingRefunded(o: ListRow): boolean {
  if (!REFUND_STATUSES.has(String(o.orderStatus ?? ''))) return false
  const day = String(o.orderDate ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const today = new Date().toLocaleDateString('en-CA', { timeZone: o.restaurantTimezone || 'America/New_York' })
  return day >= today
}
const isRecurringOrder = (o: ListRow) => !!(o.orderSubscription || o.isRecurring || o.subscriptionReference || o.recurring)

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const format = (sp.get('format') || '').toUpperCase() as ExportFormat
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) return NextResponse.json({ error: 'Pick an export' }, { status: 400 })
  const tab = sp.get('tab') === 'history' ? 'history' : 'active'
  const recurring = sp.get('recurring') || 'all'

  // The list, every page of it, through the list route itself.
  const rows: ListRow[] = []
  for (let page = 0; ; page++) {
    const q = new URLSearchParams(sp)
    for (const k of ['format', 'tab', 'recurring']) q.delete(k)
    q.set('page', String(page)); q.set('size', String(PAGE)); q.set('noSync', '1')
    const res = await listOrders(new NextRequest(new URL(`/api/restaurant/orders?${q}`, req.nextUrl.origin), { headers: req.headers }))
    if (!res.ok) return res
    const body = (await res.json()) as { content?: ListRow[]; totalElements?: number }
    rows.push(...(body.content ?? []))
    if (rows.length > MAX_ORDERS) return NextResponse.json({ error: `That is more than ${MAX_ORDERS} orders. Narrow the dates and export again.` }, { status: 400 })
    if (!body.content?.length || rows.length >= (body.totalElements ?? 0)) break
  }
  const shown = rows
    .filter((o) => !REFUND_STATUSES.has(String(o.orderStatus ?? '')) || (tab === 'active' ? isUpcomingRefunded(o) : !isUpcomingRefunded(o)))
    .filter((o) => recurring === 'all' || (recurring === 'recurring' ? isRecurringOrder(o) : !isRecurringOrder(o)))
  // FamilyMeal's message when there is nothing to export.
  if (!shown.length) return NextResponse.json({ error: 'No orders for this date range' }, { status: 404 })

  const orders = await loadExportOrders(shown.map((o) => o.orderReference))
  if (!orders.length) return NextResponse.json({ error: 'No orders for this date range' }, { status: 404 })
  const bytes = format === 'SUMMARY' ? await renderSummaryPdf(orders, { from: sp.get('fromDate') || undefined, to: sp.get('toDate') || undefined }) : format === 'DETAILS' ? await renderDetailsPdf(orders) : await renderXlsx(orders)
  const name = exportFileName(format, orders, {
    fromDate: sp.get('fromDate') || undefined, toDate: sp.get('toDate') || undefined,
    desc: (sp.get('sort') || 'order_date,desc').toLowerCase().endsWith(',desc'),
    today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  })
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': format === 'XLSX' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
}
