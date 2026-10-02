import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { normalizeSchedule } from '../../../../../../lib/reports/schedule-normalize'
import { sanitizeReportFilter } from '../../../../../../lib/reports/report-scope'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { REPORT_COLUMNS } from '../../../../../../lib/reports/native-reports'
import { sanitizeReportColumns } from '../../../../../../lib/reports/fulfillment-filter'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: return the report in the payload shape the edit form expects.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await runDiscoOrderMigrations()
    // Restaurant-scoped, not creator-scoped (RM7): any authorized user of the
    // selected location can view the report.
    const scope = await resolveDiscoScopeRef(ctx)
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const rows = (await sql`
      SELECT reference, name, frequency, time, timezone, file_type AS "fileType",
             weekday, day_of_month AS "dayOfMonth", range_type AS "rangeType",
             range_days AS "rangeDays", auto_tidy AS "autoTidy", fan_out AS "fanOut",
             columns, recipients, owner_references AS "ownerReferences", filter
      FROM disco_scheduled_reports WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid LIMIT 1
    `) as Record<string, unknown>[]
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(rows[0])
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/reports/scheduled/${ref}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch report' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch report' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: update the report (only your own).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const body = await req.json().catch(() => ({}))
    await runDiscoOrderMigrations()
    // Restaurant-scoped edit (RM7) + constrain the location filter to the caller's
    // own restaurants (RM8) so it can't be pointed at another restaurant's orders.
    const scope = await resolveDiscoScopeRef(ctx)
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const filter = await sanitizeReportFilter(ctx, scope, body?.filter)
    const sched = normalizeSchedule(body)
    // Same write-time validation as create -- an edit must not be the way a
    // retired or unresolvable column gets back into a stored config.
    const { columns: safeColumns, rejected } = sanitizeReportColumns(body?.columns, REPORT_COLUMNS.map(c => c.key))
    if (rejected.length) console.warn('[reports/scheduled] refused columns on update:', ref, rejected)

    const rows = (await sql`
      UPDATE disco_scheduled_reports SET
        name = COALESCE(NULLIF(${String(body?.name || '')}, ''), name),
        frequency = ${sched.frequency},
        time = ${sched.time},
        timezone = ${sched.timezone},
        file_type = ${body?.fileType === 'PDF' ? 'PDF' : 'CSV'},
        weekday = ${sched.weekday},
        day_of_month = ${sched.dayOfMonth},
        range_type = ${sched.rangeType},
        range_days = ${sched.rangeDays},
        auto_tidy = ${sched.autoTidy},
        fan_out = ${sched.fanOut},
        columns = ${JSON.stringify(safeColumns)}::jsonb,
        recipients = ${JSON.stringify(body?.recipients ?? [])}::jsonb,
        owner_references = ${JSON.stringify(body?.ownerReferences ?? [])}::jsonb,
        filter = ${JSON.stringify(filter)}::jsonb,
        updated_at = NOW()
      WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid
      RETURNING reference
    `) as { reference: string }[]
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ reference: rows[0].reference })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/reports/scheduled/${ref}`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Unable to update report' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!UUID_RE.test(ref)) return NextResponse.json({ ok: true })
    await runDiscoOrderMigrations()
    // Restaurant-scoped delete (RM7).
    const scope = await resolveDiscoScopeRef(ctx)
    if (scope) await sql`DELETE FROM disco_scheduled_reports WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid`
    return NextResponse.json({ ok: true })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/reports/scheduled/${ref}`, { method: 'DELETE', headers: h })
    return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : res.status })
  } catch {
    return NextResponse.json({ error: 'Unable to delete report' }, { status: 500 })
  }
}
