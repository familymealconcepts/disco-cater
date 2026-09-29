import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sanitizeReportFilter } from '../../../../../lib/reports/report-scope'
import { runDiscoOrderMigrations } from '../../../../../lib/db'
import { getColumnPresence, basicColumnSet, MIN_ORDERS_TO_JUDGE, LOOKBACK_MONTHS } from '../../../../../lib/reports/column-presence'
import { REPORT_COLUMNS } from '../../../../../lib/reports/native-reports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Backs the "Basic" preset in the scheduled-report form: which columns actually
// carry data for these locations over a 12-month look-back.
//
// It only ever SUGGESTS. The chosen set is written to disco_scheduled_reports
// like any other column choice, so the report's shape is a decision the
// restaurant made and can see — never something that changes underneath them.
//
// The response deliberately reports `unknown` separately from `empty`: a column
// whose underlying field was NULL somewhere cannot be judged, and the UI says so
// rather than implying the restaurant does not use it.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  await runDiscoOrderMigrations()
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  // Same constraint as a saved report: a caller cannot point this at locations
  // outside their own permitted set (RM8).
  const filter = await sanitizeReportFilter(ctx, scope, body?.filter)
  const locs = (filter.locationReferenceIds || []).filter(Boolean)
  const refs = locs.length ? locs : [scope]

  const presence = await getColumnPresence(refs)
  const allKeys = REPORT_COLUMNS.map(c => c.key)
  const suggested = basicColumnSet(allKeys, presence)

  const labelOf = Object.fromEntries(REPORT_COLUMNS.map(c => [c.key, c.displayLabel]))
  return NextResponse.json({
    suggested,
    dropped: presence.empty.filter(k => !suggested.includes(k)).map(k => ({ key: k, label: labelOf[k] ?? k })),
    unknown: presence.unknown.map(k => ({ key: k, label: labelOf[k] ?? k })),
    orders: presence.orders,
    judged: presence.judged,
    from: presence.from,
    to: presence.to,
    minOrders: MIN_ORDERS_TO_JUDGE,
    lookbackMonths: LOOKBACK_MONTHS,
  })
}
