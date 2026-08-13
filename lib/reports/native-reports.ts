// Native Scheduled Reports for disco — the report column catalog, CSV generation
// from disco_orders, and the "is this report due now?" scheduling check. Used by
// the reports CRUD routes and the /api/cron/scheduled-reports cron. Zero FM.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
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
  // The report's own restaurant — the base scope for the disco_orders query.
  // (`ownerReferences` is FM-parity owner metadata — the creating USER's ref —
  //  and must NEVER be used to scope orders; it isn't a restaurant reference.)
  restaurantReference: string
  ownerReferences?: string[]
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

const MONEY_KEYS = new Set(['subtotal', 'tax', 'total'])

// Fetch the report rows + resolved column list from disco_orders for the given
// config + period. Shared by both the CSV and PDF generators so the two formats
// always contain identical data.
async function fetchReportRows(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
): Promise<{ rows: OrderRow[]; useCols: string[] }> {
  const cols = (cfg.columns || []).filter(k => COLUMN_LABEL[k])
  const useCols = cols.length ? cols : REPORT_COLUMNS.map(c => c.key)

  // Scope the orders to the report's restaurant(s): the explicit location filter
  // if the user set one, otherwise the report's own restaurant. Never falls back
  // to ownerReferences (that's a USER ref and would match no orders — RM8).
  const locFilter = (cfg.filter?.locationReferenceIds || []).filter(Boolean)
  const scopeRefs = (locFilter.length ? locFilter : [cfg.restaurantReference]).filter(Boolean)
  if (!scopeRefs.length) return { rows: [], useCols }

  const byCreated = cfg.filter?.dateType === 'createdDate'
  const statuses = (cfg.filter?.orderStatuses || []).filter(Boolean)
  const deliveryTypes = (cfg.filter?.deliveryTypes || []).filter(Boolean)

  // byCreated bucket: COALESCE(placed_at, created_at) — placed_at is FM's real
  // order-creation timestamp (backfilled for pre-freeze orders, populated going
  // forward by the fixed sync); created_at is Neon sync time, which for
  // FM-mirrored orders can trail real placement by hours to years. Also now
  // timezone-aware (AT TIME ZONE the order's own restaurant's tz before the
  // ::date cast) — previously this cast used the UTC day boundary directly, the
  // same bug already fixed elsewhere (orders list, reporting cards) but missed
  // here.
  const rows = (await sql`
    SELECT o.order_number AS "orderNumber",
           to_char(o.order_date, 'YYYY-MM-DD') AS "orderDate",
           to_char(COALESCE(o.placed_at, o.created_at), 'YYYY-MM-DD') AS "createdDate",
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
    LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
    WHERE o.restaurant_reference = ANY(${scopeRefs}::uuid[])
      AND (CASE WHEN ${byCreated}
             THEN (COALESCE(o.placed_at, o.created_at) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))::date
             ELSE o.order_date
           END) >= ${period.from}::date
      AND (CASE WHEN ${byCreated}
             THEN (COALESCE(o.placed_at, o.created_at) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))::date
             ELSE o.order_date
           END) <= ${period.to}::date
      AND (${statuses.length === 0} OR o.order_status = ANY(${statuses}))
      AND (${deliveryTypes.length === 0} OR o.delivery_type = ANY(${deliveryTypes}))
    ORDER BY o.order_date DESC NULLS LAST, o.created_at DESC
  `) as OrderRow[]

  return { rows, useCols }
}

// Generate the report CSV from disco_orders for the given config + period.
export async function generateReportCsv(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
): Promise<{ csv: string; rowCount: number }> {
  const { rows, useCols } = await fetchReportRows(cfg, period)
  const header = useCols.map(k => csvCell(COLUMN_LABEL[k])).join(',')
  const lines = rows.map(r => useCols.map(k => csvCell(MONEY_KEYS.has(k) ? money(r[k]) : r[k])).join(','))
  return { csv: [header, ...lines].join('\n'), rowCount: rows.length }
}

// ── PDF generation (pure-JS via pdf-lib — no native deps, serverless-safe; same
// approach as lib/order/order-pdf.ts). Renders the selected columns as a
// landscape table that auto-paginates. ──
const PDF_GRAD = rgb(0.42, 0.43, 0.98) // #6B6EF9
const PDF_DARK = rgb(0.10, 0.06, 0.16) // #1A1028
const PDF_GREY = rgb(0.42, 0.42, 0.42)
const PDF_RULE = rgb(0.85, 0.85, 0.88)
const PDF_ZEBRA = rgb(0.96, 0.96, 0.98)

// Relative column widths so wide fields (name/email) get room and money stays tight.
const PDF_COL_WEIGHT: Record<string, number> = {
  orderNumber: 1.1, orderDate: 1, createdDate: 1, orderType: 0.9, deliveryType: 1.3,
  orderStatus: 1, customerName: 1.7, customerEmail: 2.2, customerPhone: 1.3,
  subtotal: 0.9, tax: 0.8, total: 0.9,
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxW: number): string {
  if (maxW <= 0 || font.widthOfTextAtSize(text, size) <= maxW) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1)
  return t + '…'
}

// Generate the report PDF from disco_orders for the given config + period.
export async function generateReportPdf(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
): Promise<{ pdf: Uint8Array; rowCount: number }> {
  const { rows, useCols } = await fetchReportRows(cfg, period)
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const W = 792, H = 612, M = 40, availW = W - 2 * M // US Letter landscape
  const SIZE = 8, PAD = 4, ROW_H = 15, BOTTOM = M + 4
  const totalWeight = useCols.reduce((s, k) => s + (PDF_COL_WEIGHT[k] ?? 1), 0) || 1
  const colW = useCols.map(k => (PDF_COL_WEIGHT[k] ?? 1) / totalWeight * availW)
  const colX: number[] = []
  let acc = M
  for (const w of colW) { colX.push(acc); acc += w }

  let page = doc.addPage([W, H])
  let y = H - M

  const cell = (text: string, i: number, atY: number, opts: { font?: PDFFont; align?: 'l' | 'r'; color?: ReturnType<typeof rgb> } = {}) => {
    const f = opts.font ?? font
    const t = truncateToWidth(text, f, SIZE, colW[i] - PAD * 2)
    const x = opts.align === 'r' ? colX[i] + colW[i] - PAD - f.widthOfTextAtSize(t, SIZE) : colX[i] + PAD
    page.drawText(t, { x, y: atY, size: SIZE, font: f, color: opts.color ?? PDF_DARK })
  }

  const drawTableHead = () => {
    page.drawText('disco cater', { x: M, y, size: 13, font: bold, color: PDF_GRAD })
    const meta = `${period.from} to ${period.to}  ·  ${rows.length} order${rows.length === 1 ? '' : 's'}`
    page.drawText(meta, { x: W - M - font.widthOfTextAtSize(meta, 9), y, size: 9, font, color: PDF_GREY })
    y -= 18
    page.drawText(truncateToWidth(cfg.name || 'Report', bold, 12, availW * 0.7), { x: M, y, size: 12, font: bold, color: PDF_DARK })
    y -= 16
    useCols.forEach((k, i) => cell(COLUMN_LABEL[k], i, y, { font: bold, align: MONEY_KEYS.has(k) ? 'r' : 'l' }))
    y -= 6
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: PDF_RULE })
    y -= 12
  }

  drawTableHead()
  rows.forEach((r, idx) => {
    if (y < BOTTOM) { page = doc.addPage([W, H]); y = H - M; drawTableHead() }
    if (idx % 2 === 1) page.drawRectangle({ x: M, y: y - 4, width: availW, height: ROW_H, color: PDF_ZEBRA })
    useCols.forEach((k, i) => {
      const isMoney = MONEY_KEYS.has(k)
      const raw = isMoney ? (r[k] == null || r[k] === '' ? '' : `$${Number(r[k]).toFixed(2)}`) : String(r[k] ?? '')
      cell(raw, i, y, { align: isMoney ? 'r' : 'l' })
    })
    y -= ROW_H
  })
  if (!rows.length) page.drawText('No data for this period.', { x: M, y: y - 4, size: 10, font, color: PDF_GREY })

  return { pdf: await doc.save(), rowCount: rows.length }
}

// Unified entry: build the report body in the requested format, with the right
// content-type + file extension. Used by the cron email + the on-demand download.
export async function buildReport(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
  fileType: string,
): Promise<{ body: string | Uint8Array; contentType: string; ext: 'pdf' | 'csv'; rowCount: number }> {
  if (fileType === 'PDF') {
    const { pdf, rowCount } = await generateReportPdf(cfg, period)
    return { body: pdf, contentType: 'application/pdf', ext: 'pdf', rowCount }
  }
  const { csv, rowCount } = await generateReportCsv(cfg, period)
  return { body: csv || 'No data for this period.', contentType: 'text/csv', ext: 'csv', rowCount }
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
