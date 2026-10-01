// Native Scheduled Reports for disco — the report column catalog, CSV generation
// from disco_orders, and the "is this report due now?" scheduling check. Used by
// the reports CRUD routes and the /api/cron/scheduled-reports cron. Zero FM.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import { sql } from '../db'
import { displayEmail } from '../customer-email-guard'
import {
  ORDER_REPORT_COLUMNS, LOCATION_COLUMN, buildOrderReportRows, totalsRow,
  subsidyShouldShow, reconcileRow, type OrderReportRow,
} from './order-report-rows'
import { resolvePeriod, type PeriodSpec, type Frequency } from './report-period'
import { getColumnPresence, NEVER_HIDE } from './column-presence'

export interface ReportColumn { category: string; key: string; displayLabel: string }

// ── ONE CATALOGUE, SHARED WITH THE ON-DEMAND EXPORT ──────────────────────────
// The old 12-column catalogue is GONE. It ended in "Total" — the customer charge
// — with no payout column, so a scheduled report emailed the same misleading
// figure the download had, except nobody is watching when it arrives and a
// restaurant may act on it.
//
// These are the same ReportColumnDef objects the on-demand CSV/XLS/PDF render,
// imported rather than restated: two implementations of a payout figure drifting
// apart is precisely the failure this work exists to prevent. A column named here
// therefore cannot mean something different in the download.
//
// `Location` is offered too, for a report covering several restaurants.
export const REPORT_COLUMNS: ReportColumn[] = [
  { category: 'Restaurant', key: LOCATION_COLUMN.key, displayLabel: LOCATION_COLUMN.label },
  ...ORDER_REPORT_COLUMNS.map(c => ({
    category: c.financial ? 'Financials' : 'Order',
    key: c.key,
    displayLabel: c.label,
  })),
]

// TOTAL DISTRIBUTED IS NOT REMOVABLE. The picker stays — a restaurant choosing
// which columns it receives is fine — but the payout is the one column whose
// absence created this problem, and a money report without it is the thing we
// just fixed. It is force-appended to whatever the picker stores, so an old
// saved config or a hand-edited payload cannot produce a report without it.
const ALWAYS_INCLUDED = 'totalDistributed'

const COLUMN_LABEL: Record<string, string> = Object.fromEntries(REPORT_COLUMNS.map(c => [c.key, c.displayLabel]))

export interface ReportFilter {
  dateType?: 'orderDate' | 'createdDate'
  orderStatuses?: string[]
  deliveryTypes?: string[]
  locationReferenceIds?: string[]
}
/**
 * Column keys a saved report asked for that no longer exist.
 *
 * NEVER SILENT. Nine of the twelve keys on Gracious Bakery's report were
 * orphaned when commit 3dc0666 (2026-09-15) replaced the column model, and the
 * filter below dropped them without a word — so a restaurant had configured
 * Subtotal, Tax and Total and received a CSV with none of them, and nothing
 * anywhere said so. Surfaced now through buildReport's return value, logged by
 * the cron, and reported by the scheduled-reports API so the editor can show it.
 */
export interface InvalidColumnReport { keys: string[]; kept: number }

export interface ScheduledReportConfig {
  name: string
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  time: string          // 'HH:MM' — the cron is hourly, so only HH is honoured
  timezone: string
  /** WEEKLY: 0=Sun..6=Sat. Null means Monday, matching every pre-existing report. */
  weekday?: number | null
  /** MONTHLY: 1..28 or 'LAST'. Null means the 1st. */
  dayOfMonth?: string | number | null
  rangeType?: string | null
  rangeDays?: number | null
  /**
   * Re-evaluate the empty-column set on every send, instead of keeping the
   * columns the restaurant chose. OFF by default: a report whose shape changes
   * on its own is the flicker this feature was asked to avoid.
   */
  autoTidy?: boolean
  /**
   * Sweep up orders dated before this window that only synced after the given
   * timestamp — normally the report's own previous run. See
   * BuildOptions.catchUpSince in lib/reports/order-report-rows.ts.
   */
  catchUpSince?: string | null
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

/**
 * The [from, to] a report covers. Delegates to lib/reports/report-period.ts,
 * which computes it in the report's OWN timezone, ends it at yesterday, and
 * makes "monthly" the previous calendar month. See that file for the three
 * defects this replaced — all of which affected every report sent to date.
 *
 * The old signature (frequency, now) is kept working for any caller that has
 * not been passed a full spec yet; it resolves to PREVIOUS_PERIOD in the
 * default timezone, which is what those callers already meant.
 */
export function reportPeriod(
  frequencyOrSpec: string | PeriodSpec,
  now: Date,
): { from: string; to: string } {
  const spec: PeriodSpec = typeof frequencyOrSpec === 'string'
    ? { frequency: (frequencyOrSpec as Frequency) || 'WEEKLY', timezone: 'America/New_York', rangeType: 'PREVIOUS_PERIOD' }
    : frequencyOrSpec
  return resolvePeriod(spec, now)
}

// Money keys come from the SHARED column set, so a column added there formats as
// currency here without a second list to remember to update. The old hand-written
// set (subtotal/tax/total) silently left every new financial column unformatted
// and produced an EMPTY totals row.
const MONEY_KEYS = new Set(ORDER_REPORT_COLUMNS.filter(c => c.financial).map(c => c.key))

// Fetch the report rows + resolved column list from disco_orders for the given
// config + period. Shared by both the CSV and PDF generators so the two formats
// always contain identical data.
/**
 * Rows for a scheduled report, from the SHARED builder.
 *
 * Every rule the on-demand export applies applies here identically, because it is
 * the same function: the settlement branch on disco_sale_transactions.source
 * (never source_of_order), the split tips, and the verified Total Distributed.
 */
async function fetchReportRows(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
): Promise<{ rows: OrderReportRow[]; useCols: string[]; totals: Partial<OrderReportRow>; invalidColumns: string[] }> {
  // Scope to the report's restaurant(s): the explicit location filter if set,
  // otherwise the report's own restaurant. NEVER ownerReferences — that is a USER
  // ref and would match no orders (RM8).
  const locFilter = (cfg.filter?.locationReferenceIds || []).filter(Boolean)
  const scopeRefs = (locFilter.length ? locFilter : [cfg.restaurantReference]).filter(Boolean)

  const requested = (cfg.columns || []).map(String)
  const chosen = requested.filter(k => COLUMN_LABEL[k])
  const invalidColumns = requested.filter(k => !COLUMN_LABEL[k])
  if (invalidColumns.length) {
    // Loud, and it names the report: a column a restaurant explicitly asked for
    // that cannot be produced is a content defect, not a formatting nicety.
    console.error(`[buildReport] "${cfg.name}" requests ${invalidColumns.length} column(s) that no longer exist and they will be absent: ${invalidColumns.join(', ')}`)
  }
  let useCols = chosen.length ? chosen : ORDER_REPORT_COLUMNS.map(c => c.key)
  if (!useCols.includes(ALWAYS_INCLUDED)) useCols = [...useCols, ALWAYS_INCLUDED]

  if (!scopeRefs.length) return { rows: [], useCols, totals: {}, invalidColumns }

  const rows = await buildOrderReportRows({
    refs: scopeRefs,
    from: period.from,
    to: period.to,
    dateField: cfg.filter?.dateType === 'createdDate' ? 'created_at' : 'order_date',
    orderStatuses: cfg.filter?.orderStatuses,
    deliveryTypes: cfg.filter?.deliveryTypes,
    catchUpSince: cfg.catchUpSince ?? null,
  })

  // Subsidy: hidden unless a row actually carries one, exactly as the download
  // behaves. Without it Total Distributed cannot be derived from the visible
  // columns; permanently on, it is a zero column on every report ever sent.
  const showSubsidy = subsidyShouldShow(rows)
  if (!showSubsidy) useCols = useCols.filter(k => k !== 'thirdPartySubsidy')
  else if (!useCols.includes('thirdPartySubsidy')) {
    const at = useCols.indexOf(ALWAYS_INCLUDED)
    useCols = at >= 0 ? [...useCols.slice(0, at), 'thirdPartySubsidy', ...useCols.slice(at)] : [...useCols, 'thirdPartySubsidy']
  }
  // Only ever offer Location when the report genuinely spans several.
  if (new Set(rows.map(r => r.location)).size <= 1) useCols = useCols.filter(k => k !== 'location')

  // ── OPTIONAL AUTO-TIDY ────────────────────────────────────────────────────
  // OFF by default. When a restaurant has explicitly asked for it, drop the
  // columns proven empty over a 12-MONTH look-back — deliberately not over the
  // report's own period, which is what would make a column flicker in and out
  // between a month with one third-party order and a month without.
  //
  // getColumnPresence keeps NULL separate from 0, so a field FamilyMeal never
  // sent (Stripe fee, chiefly) reads as unjudgeable and is kept. NEVER_HIDE and
  // the minimum-evidence bar do the rest.
  if (cfg.autoTidy) {
    try {
      const presence = await getColumnPresence(scopeRefs)
      if (presence.judged) {
        const drop = new Set(presence.empty.filter(k => !NEVER_HIDE.has(k) && k !== ALWAYS_INCLUDED))
        if (drop.size) useCols = useCols.filter(k => !drop.has(k))
      }
    } catch (e) {
      // Never fail a send over a cosmetic decision — keep every column.
      console.error('[buildReport] auto-tidy presence lookup failed; sending the full column set:', e instanceof Error ? e.message : e)
    }
  }

  return { rows, useCols, totals: totalsRow(rows), invalidColumns }
}

/**
 * Thrown when a row's payout does not reconcile against its own visible
 * components. The caller MUST NOT send the email — see the cron.
 *
 * An emailed report is worse than a failed download: nobody is watching when it
 * sends, and a restaurant may act on a wrong payout before anyone notices. The
 * subsidy subtraction in particular has never been exercised by a real order.
 */
export class ReportReconciliationError extends Error {
  readonly failures: { orderId: string; expected: number; got: number; delta: number }[]
  constructor(failures: { orderId: string; expected: number; got: number; delta: number }[]) {
    super(`payout failed to reconcile on ${failures.length} row(s) — first #${failures[0]?.orderId}`)
    this.name = 'ReportReconciliationError'
    this.failures = failures
  }
}

function assertReconciled(rows: OrderReportRow[]): void {
  const failures = rows.map(r => ({ r, c: reconcileRow(r) })).filter(x => !x.c.ok)
    .map(x => ({ orderId: x.r.orderId, expected: x.c.expected, got: x.r.totalDistributed, delta: x.c.delta }))
  if (failures.length) throw new ReportReconciliationError(failures)
}

const cellOf = (r: Partial<OrderReportRow>, key: string): unknown => (r as Record<string, unknown>)[key]

export async function generateReportCsv(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
): Promise<{ csv: string; rowCount: number; invalidColumns: string[]; rows: OrderReportRow[] }> {
  const { rows, useCols, totals, invalidColumns } = await fetchReportRows(cfg, period)
  assertReconciled(rows)
  const header = useCols.map(k => csvCell(COLUMN_LABEL[k])).join(',')
  const lines = rows.map(r => useCols.map(k => csvCell(MONEY_KEYS.has(k) ? money(cellOf(r, k)) : cellOf(r, k))).join(','))
  // Totals row, as the download has and as FM does.
  const t = useCols.map(k => csvCell(MONEY_KEYS.has(k) ? money(cellOf(totals, k)) : ''))
  const labelAt = useCols.findIndex(k => !MONEY_KEYS.has(k))
  if (labelAt >= 0) t[labelAt] = csvCell('TOTAL')
  return { csv: [header, ...lines, t.join(',')].join('\n'), rowCount: rows.length, invalidColumns, rows }
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
// ORPHANED BY THE SAME RENAME. Every key here was an old column key, so since
// commit 3dc0666 not one of them has matched and every column has fallen to the
// default weight. Re-keyed to the current set.
const PDF_COL_WEIGHT: Record<string, number> = {
  location: 1.8, orderId: 1.1, customerName: 1.7, createdDate: 1, serviceType: 1.3,
  orderDate: 1, orderTime: 0.9,
  netSales: 0.95, stateTax: 0.85, localTax: 0.85, otherTax: 0.85,
  selfDeliveryFee: 1, thirdPartyDeliveryFee: 1,
  tipPickup: 0.85, tipSelfDelivery: 0.95, tipThirdPartyDelivery: 1,
  serviceCharge: 0.95, discount: 0.85, leadGenOne: 0.9, leadGenTwo: 0.9,
  gross: 0.95, stripeFee: 0.9, refundAmount: 0.9, thirdPartySubsidy: 1,
  totalDistributed: 1.1,
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
): Promise<{ pdf: Uint8Array; rowCount: number; invalidColumns: string[]; rows: OrderReportRow[] }> {
  const { rows, useCols, totals, invalidColumns } = await fetchReportRows(cfg, period)
  assertReconciled(rows)
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
      const v = cellOf(r, k)
      const raw = isMoney ? (v == null || v === '' ? '' : `$${Number(v).toFixed(2)}`) : String(v ?? '')
      cell(raw, i, y, { align: isMoney ? 'r' : 'l' })
    })
    y -= ROW_H
  })
  // Totals row — same as the download, same as FM.
  if (rows.length) {
    if (y < BOTTOM) { page = doc.addPage([W, H]); y = H - M; drawTableHead() }
    page.drawRectangle({ x: M, y: y - 4, width: availW, height: ROW_H, color: PDF_ZEBRA })
    const labelAt = useCols.findIndex(k => !MONEY_KEYS.has(k))
    useCols.forEach((k, i) => {
      const isMoney = MONEY_KEYS.has(k)
      const v = cellOf(totals, k)
      const raw = i === labelAt ? 'TOTAL' : isMoney ? (v == null ? '' : `$${Number(v).toFixed(2)}`) : ''
      cell(raw, i, y, { align: isMoney ? 'r' : 'l', font: bold })
    })
    y -= ROW_H
  }
  if (!rows.length) page.drawText('No data for this period.', { x: M, y: y - 4, size: 10, font, color: PDF_GREY })

  return { pdf: await doc.save(), rowCount: rows.length, invalidColumns, rows }
}

// Unified entry: build the report body in the requested format, with the right
// content-type + file extension. Used by the cron email + the on-demand download.
export async function buildReport(
  cfg: ScheduledReportConfig,
  period: { from: string; to: string },
  fileType: string,
): Promise<{ body: string | Uint8Array; contentType: string; ext: 'pdf' | 'csv'; rowCount: number; invalidColumns: string[]; lateRows: number }> {
  // Counted here rather than inside the generators so both formats report it
  // identically: rows whose date falls OUTSIDE the stated window are the late
  // arrivals the catch-up clause swept in, and the email says so.
  const lateOf = (rows: OrderReportRow[]) => cfg.catchUpSince
    ? rows.filter(r => {
        const d = cfg.filter?.dateType === 'createdDate' ? r.createdDate : r.orderDate
        return !!d && d < period.from
      }).length
    : 0

  if (fileType === 'PDF') {
    const { pdf, rowCount, invalidColumns, rows } = await generateReportPdf(cfg, period)
    return { body: pdf, contentType: 'application/pdf', ext: 'pdf', rowCount, invalidColumns, lateRows: lateOf(rows) }
  }
  const { csv, rowCount, invalidColumns, rows } = await generateReportCsv(cfg, period)
  return { body: csv || 'No data for this period.', contentType: 'text/csv', ext: 'csv', rowCount, invalidColumns, lateRows: lateOf(rows) }
}

// Scheduling now lives in report-period.ts alongside the window maths, because
// the two have to agree about what "the restaurant's Monday" means. Re-exported
// so existing importers (the cron, the tests) are unchanged.
export { isReportDue } from './report-period'
