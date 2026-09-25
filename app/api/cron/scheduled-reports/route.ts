import { NextRequest, NextResponse } from 'next/server'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'
import { sendEmail } from '../../../../lib/email/send'
import { layout } from '../../../../lib/email/layout'
import { buildReport, isReportDue, reportPeriod, ReportReconciliationError, type ScheduledReportConfig } from '../../../../lib/reports/native-reports'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Hourly Scheduled Reports cron. For each active disco_scheduled_reports row that
// is due now (WEEKLY on Mondays / MONTHLY on the 1st, at its configured hour in its
// timezone), generate the CSV from disco_orders, email it to the recipients, and
// record a run. `?force=1` (with CRON_SECRET) runs every active report regardless
// of schedule — a manual "run now" + the test hook. Auth: Bearer CRON_SECRET.
function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

interface ReportRow {
  reference: string; restaurant_reference: string; name: string
  frequency: string; time: string; timezone: string; file_type: string
  columns: unknown; recipients: unknown; owner_references: unknown; filter: unknown
  last_run_at: string | null
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const force = req.nextUrl.searchParams.get('force') === '1'
  const forceRef = req.nextUrl.searchParams.get('reportRef') || ''
  const now = new Date()

  await runDiscoOrderMigrations()
  const reports = (forceRef
    ? await sql`
        SELECT reference, restaurant_reference, name, frequency, time, timezone, file_type,
               columns, recipients, owner_references, filter, last_run_at::text AS last_run_at
        FROM disco_scheduled_reports WHERE active = true AND reference = ${forceRef}::uuid`
    : await sql`
        SELECT reference, restaurant_reference, name, frequency, time, timezone, file_type,
               columns, recipients, owner_references, filter, last_run_at::text AS last_run_at
        FROM disco_scheduled_reports WHERE active = true`) as ReportRow[]

  const results: { report: string; status: string; rows?: number; error?: string }[] = []
  for (const r of reports) {
    if (!force && !isReportDue(r, now)) continue
    const cfg: ScheduledReportConfig = {
      name: r.name,
      frequency: r.frequency === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY',
      time: r.time, timezone: r.timezone,
      columns: Array.isArray(r.columns) ? (r.columns as string[]) : [],
      restaurantReference: r.restaurant_reference,
      filter: (r.filter && typeof r.filter === 'object' ? r.filter : {}) as ScheduledReportConfig['filter'],
    }
    const recipients = (Array.isArray(r.recipients) ? (r.recipients as string[]) : []).filter(Boolean)
    let status = 'SUCCESS'
    let rowCount = 0
    let error = ''
    try {
      const period = reportPeriod(cfg.frequency, now)
      const gen = await buildReport(cfg, period, r.file_type)
      rowCount = gen.rowCount
      if (recipients.length) {
        const filename = `${r.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}_${period.from}_${period.to}.${gen.ext}`
        const res = await sendEmail({
          to: recipients.join(','),
          subject: `${r.name} — ${period.from} to ${period.to} | Disco Cater`,
          // layout() like every other transactional email — this was the one
          // sender passing bare HTML, so the report arrived with no Disco Cater
          // logo and no concierge footer while carrying a "| Disco Cater" subject.
          html: layout(`<p>Your scheduled report <strong>${r.name}</strong> for ${period.from} to ${period.to} is attached (${gen.rowCount} order${gen.rowCount === 1 ? '' : 's'}).</p>`),
          attachments: [{ filename, content: gen.body, contentType: gen.contentType }],
        })
        if (!res.success) { status = 'FAILED'; error = res.error || 'email failed' }
      }
    } catch (e) {
      status = 'FAILED'; error = e instanceof Error ? e.message : String(e)
      console.error('[cron/scheduled-reports]', r.reference, error)
      // A PAYOUT THAT DOES NOT RECONCILE IS NOT AN ORDINARY FAILURE. buildReport
      // throws BEFORE sendEmail, so nothing goes out — but a scheduled report
      // that silently stops arriving is its own problem, and the restaurant is
      // not watching. This is the one send path where a wrong number would reach
      // someone with nobody looking, so it is alerted rather than merely logged.
      //
      // alertOps (not alertOnce): each scheduled run is a distinct event, and a
      // report that fails two weeks running should say so twice.
      if (e instanceof ReportReconciliationError) {
        await alertOps('scheduled report WITHHELD — the payout figures did not reconcile, so no email was sent', {
          report: r.name, reference: r.reference, restaurantReference: r.restaurant_reference,
          recipients: recipients.length, failures: e.failures.slice(0, 5),
        })
      }
    }
    await sql`
      INSERT INTO disco_report_runs (scheduled_report_reference, restaurant_reference, report_name, file_type, run_status, row_count)
      VALUES (${r.reference}::uuid, ${r.restaurant_reference}::uuid, ${r.name}, ${r.file_type}, ${status}, ${rowCount})
    `.catch(() => {})
    await sql`UPDATE disco_scheduled_reports SET last_run_at = NOW() WHERE reference = ${r.reference}::uuid`.catch(() => {})
    results.push({ report: r.name, status, rows: rowCount, ...(error ? { error } : {}) })
  }
  return NextResponse.json({ ran: results.length, results })
}
