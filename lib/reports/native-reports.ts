// Native Scheduled Reports for disco — the report column catalog, CSV generation
// from disco_orders, and the "is this report due now?" scheduling check. Used by
// the reports CRUD routes and the /api/cron/scheduled-reports cron. Zero FM.
import { sql } from '../db'

export interface ReportColumn { category: string; key: string; displayLabel: string }

// The columns a restaurant can include in a scheduled report. `key` is what the
// payload stores; the generator maps each to a value below.
export const REPORT_COLUMNS: ReportColumn[] = [
  { category: 'Order', key: 'orderNumber', displayLabel: 'Order #' },
  { category: 'Order', key: 'orderDate', displayLabel: 'Order Date' },
  { category: 'Order', key: 'createdDate', displayLabel: 'Created Date' },
  { category: 'Order', key: 'orderType', displayLabel: 'Order Type' },
  { category: 'Order', key: 'deliveryType', displayLabel: 'Delivery Type' },
  { category: 'Order', key: 'orderStatus', displayLabel: 'Status' },
  { category: 'Customer', key: 'customerName', displayLabel: 'Customer' },
  { category: 'Customer', key: 'customerEmail', displayLabel: 'Email' },
  { category: 'Customer', key: 'customerPhone', displayLabel: 'Phone' },
  { category: 'Financials', key: 'subtotal', displayLabel: 'Subtotal' },
  { category: 'Financials', key: 'tax', displayLabel: 'Tax' },
  { category: 'Financials', key: 'total', displayLabel: 'Total' },
]
const COLUMN_LABEL: Record<string, string> = Object.fromEntries(REPORT_COLUMNS.map(c => [c.key, c.displayLabel]))

export interface ReportFilter {
  dateType?: 'orderDate' | 'createdDate'
  orderStatuses?: string[]
  deliveryTypes?: string[]
  locationReferenceIds?: string[]
}
export interface ScheduledReportConfig {
  name: string
  frequency: 'WEEKLY' | 'MONTHLY'
  time: string          // 'HH:MM'
  timezone: string
  columns: string[]
  ownerReferences: string[]
  filter: ReportFilter
}

type OrderRow = Record<string, unknown>
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
const money = (v: unknown) => (v == null ? '' : Number(v).toFixed(2))

// The [from, to] the report covers, ending now: weekly = last 7 days, monthly =
// last calendar month-ish (30 days). Returned as ISO dates.
export function reportPeriod(frequency: string, now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10)
  const days = frequency === 'MONTHLY' ? 31 : 7
  const from = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10)
  return { from, to }
}

// Generate the report CSV from disco_orders for the given config + period.
export async function generateReportCsv(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
): Promise<{ csv: string; rowCount: number }> {
  const refs = (cfg.ownerReferences || []).filter(Boolean)
  const locFilter = (cfg.filter?.locationReferenceIds || []).filter(Boolean)
  const scopeRefs = locFilter.length ? locFilter : refs
  if (!scopeRefs.length) return { csv: '', rowCount: 0 }

  const byCreated = cfg.filter?.dateType === 'createdDate'
  const statuses = (cfg.filter?.orderStatuses || []).filter(Boolean)
  const deliveryTypes = (cfg.filter?.deliveryTypes || []).filter(Boolean)

  const rows = (await sql`
    SELECT o.order_number AS "orderNumber",
           to_char(o.order_date, 'YYYY-MM-DD') AS "orderDate",
           to_char(o.created_at, 'YYYY-MM-DD') AS "createdDate",
           o.order_type AS "orderType",
           o.delivery_type AS "deliveryType",
           o.order_status AS "orderStatus",
           TRIM(COALESCE(o.customer_first_name,'') || ' ' || COALESCE(o.customer_last_name,'')) AS "customerName",
           o.customer_email AS "customerEmail",
           o.customer_phone AS "customerPhone",
           o.subtotal AS "subtotal",
           o.total AS "total",
           COALESCE((SELECT SUM(st.state_tax + st.local_tax + st.other_tax)
                     FROM disco_sale_transactions st
                     WHERE st.order_id = o.id AND st.transaction_type = 'ORIGINAL'), 0) AS "tax"
    FROM disco_orders o
    WHERE o.restaurant_reference = ANY(${scopeRefs}::uuid[])
      AND (CASE WHEN ${byCreated} THEN o.created_at::date ELSE o.order_date END) >= ${period.from}::date
      AND (CASE WHEN ${byCreated} THEN o.created_at::date ELSE o.order_date END) <= ${period.to}::date
      AND (${statuses.length === 0} OR o.order_status = ANY(${statuses}))
      AND (${deliveryTypes.length === 0} OR o.delivery_type = ANY(${deliveryTypes}))
    ORDER BY o.order_date DESC NULLS LAST, o.created_at DESC
  `) as OrderRow[]

  const cols = (cfg.columns || []).filter(k => COLUMN_LABEL[k])
  const useCols = cols.length ? cols : REPORT_COLUMNS.map(c => c.key)
  const moneyKeys = new Set(['subtotal', 'tax', 'total'])
  const header = useCols.map(k => csvCell(COLUMN_LABEL[k])).join(',')
  const lines = rows.map(r => useCols.map(k => csvCell(moneyKeys.has(k) ? money(r[k]) : r[k])).join(','))
  return { csv: [header, ...lines].join('\n'), rowCount: rows.length }
}

// Local wall-clock parts (weekday 0=Sun..6=Sat, day-of-month, hour) in a timezone.
function localParts(now: Date, timezone: string): { weekday: number; day: number; hour: number } {
  const tz = timezone || 'America/New_York'
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { weekday: WD[get('weekday')] ?? 0, day: Number(get('day')) || 1, hour: (Number(get('hour')) % 24) || 0 }
}

// Is the report due at `now`? Fires WEEKLY on Mondays / MONTHLY on the 1st, at the
// configured hour in its timezone. `lastRunAt` guards against a same-day re-fire
// (the cron runs hourly). No explicit day in the payload → Monday / 1st.
export function isReportDue(
  report: { frequency: string; time: string; timezone: string; last_run_at: string | Date | null },
  now: Date,
): boolean {
  const targetHour = Number(String(report.time || '09:00').split(':')[0]) || 0
  const { weekday, day, hour } = localParts(now, report.timezone)
  if (hour !== targetHour) return false
  const dayMatch = report.frequency === 'MONTHLY' ? day === 1 : weekday === 1
  if (!dayMatch) return false
  if (report.last_run_at) {
    const since = now.getTime() - new Date(report.last_run_at).getTime()
    if (since < 20 * 3600 * 1000) return false // already ran this occurrence
  }
  return true
}
