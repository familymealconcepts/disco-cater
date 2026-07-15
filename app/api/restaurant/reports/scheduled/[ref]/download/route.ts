import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../../../lib/db'
import { buildReport, reportPeriod, type ScheduledReportConfig } from '../../../../../../../lib/reports/native-reports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/restaurant/reports/scheduled/{ref}/download
// On-demand download of a Disco-native scheduled report for its current period,
// in the format the report was configured with (PDF or CSV). Native-only; scoped
// to the caller's own report (created_by) or a report in their selected location.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType !== 'disco') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ref } = await params
  await runDiscoOrderMigrations()
  const scope = await resolveDiscoScopeRef(ctx)

  if (!scope) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  const rows = (await sql`
    SELECT reference, restaurant_reference, name, frequency, time, timezone, file_type,
           columns, filter
    FROM disco_scheduled_reports
    WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid
    LIMIT 1
  `) as Array<{
    restaurant_reference: string; name: string; frequency: string; time: string; timezone: string; file_type: string
    columns: unknown; filter: unknown
  }>
  if (!rows.length) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  const r = rows[0]

  const cfg: ScheduledReportConfig = {
    name: r.name,
    frequency: r.frequency === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY',
    time: r.time, timezone: r.timezone,
    columns: Array.isArray(r.columns) ? (r.columns as string[]) : [],
    restaurantReference: r.restaurant_reference,
    filter: (r.filter && typeof r.filter === 'object' ? r.filter : {}) as ScheduledReportConfig['filter'],
  }
  const period = reportPeriod(cfg.frequency, new Date())

  try {
    const gen = await buildReport(cfg, period, r.file_type)
    const slug = r.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const filename = `${slug}_${period.from}_${period.to}.${gen.ext}`
    const body = typeof gen.body === 'string' ? gen.body : Buffer.from(gen.body)
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': gen.contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    console.error('[reports/download]', ref, e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to generate report' }, { status: 500 })
  }
}
