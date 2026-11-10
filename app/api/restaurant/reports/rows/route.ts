import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { resolveReportRefs, loadOrderReport, reportTableColumns } from '../../../../../lib/reports/order-report-load'
import { TOTALS_LABEL } from '../../../../../lib/reports/order-report-rows'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The Reporting page's on-screen orders table, as JSON.
//
// SAME LOADER AS THE DOWNLOADS (../export): same scope (a restaurant sees only
// its own locations; the set comes from the session, never the request), same
// rows, same visible columns, same totals row, same refusal when a payout does
// not reconcile. Same query parameters too — from, to, dateField=order|created —
// so the page can hand one set of parameters to both.
//
// Status and Payment are always returned as columns: the table shows them as
// badges even when the export's column rule would drop a blank Payment column.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const from = sp.get('from') || ''
  const to = sp.get('to') || ''
  const dateField = sp.get('dateField') === 'created' ? 'created' : 'order'
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required.' }, { status: 400 })

  try {
    const refs = await resolveReportRefs(ctx)
    if (!refs.length) {
      return NextResponse.json({
        error: 'Choose a location to see its orders.',
        description: 'This session is not currently pointed at a restaurant. Pick a location in the portal.',
      }, { status: 400 })
    }
    const report = await loadOrderReport({
      refs, from, to, dateField: dateField === 'created' ? 'created_at' : 'order_date', logTag: 'reports/rows',
    })
    if (!report.ok) {
      const { broken } = report
      return NextResponse.json({
        error: 'Report withheld: the payout figures did not reconcile.',
        description: `${broken.length} order(s) could not be reconciled — first: #${broken[0].r.orderId}. This has been logged. Email concierge@discocater.com.`,
      }, { status: 500 })
    }
    const columns = reportTableColumns(report.cols)
    return NextResponse.json({
      from, to, dateField,
      columns,
      rows: report.rows,
      totals: report.totals,
      totalsLabel: TOTALS_LABEL,
    })
  } catch (e) {
    console.error('[reports/rows] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load the orders report' }, { status: 500 })
  }
}
