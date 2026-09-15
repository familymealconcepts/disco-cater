import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { sql } from '../../../../../lib/db'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { contentDisposition } from '../../../../../lib/download-filename'
import { resolveDiscoGroupScope } from '../../../../../lib/restaurant-write-scope'
import {
  ORDER_REPORT_COLUMNS, LOCATION_COLUMN, buildOrderReportRows, totalsRow,
  subsidyShouldShow, reconcileRow, type OrderReportRow, type ReportColumnDef,
} from '../../../../../lib/reports/order-report-rows'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const money = (n: number) => `$${n.toFixed(2)}`

// ── COLUMN SET ────────────────────────────────────────────────────────────────
// FamilyMeal's RESTAURANT_REPORT_COLUMNS, in FM's order with FM's headers, so a
// restaurant reading both sees the same sheet. The definition lives in
// lib/reports/order-report-rows.ts along with the payout maths; this file is the
// three renderers and nothing else.
//
// The old ten-column shape ended in "Total", which was the CUSTOMER CHARGE: on
// #900000142 it read $1,159.00 while $1,011.29 reached the restaurant. The final
// column is now Total Distributed — the payout, verified to the cent against
// Stripe's transfer_data.amount on eleven real orders.
function activeColumns(rows: OrderReportRow[], multiLocation: boolean, forceSubsidy: boolean): ReportColumnDef[] {
  // The subsidy column is hidden while every row is zero (which is every order
  // ever placed) and AUTO-SHOWN the moment one is not, so Total Distributed can
  // always be derived from what is on screen. Kealoha can also force it on.
  const showSubsidy = forceSubsidy || subsidyShouldShow(rows)
  const cols = ORDER_REPORT_COLUMNS.filter(c => c.key !== 'thirdPartySubsidy' || showSubsidy)
  return multiLocation ? [LOCATION_COLUMN, ...cols] : cols
}

const MONEY_KEYS = new Set(ORDER_REPORT_COLUMNS.filter(c => c.financial).map(c => c.key))

function cellFor(r: Partial<OrderReportRow>, key: string): string {
  const v = (r as Record<string, unknown>)[key]
  if (MONEY_KEYS.has(key)) return v == null ? '' : money(num(v))
  return v == null ? '' : String(v)
}

function rowValues(r: Partial<OrderReportRow>, cols: ReportColumnDef[]): string[] {
  return cols.map(c => cellFor(r, c.key))
}

// ── Formatters ───────────────────────────────────────────────────────────────
function toCsv(rows: OrderReportRow[], cols: ReportColumnDef[], totals: Partial<OrderReportRow>): string {
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const lines = [cols.map(c => c.label).join(',')]
  for (const r of rows) lines.push(rowValues(r, cols).map(esc).join(','))
  // FM sums its financial columns in a trailing row; the label sits in the first
  // non-financial cell so the money lines up under its own column.
  const t = rowValues(totals, cols)
  const labelAt = cols.findIndex(c => !c.financial)
  if (labelAt >= 0) t[labelAt] = 'TOTAL'
  lines.push(t.map(esc).join(','))
  return lines.join('\r\n')
}

// Excel opens an HTML <table> served as application/vnd.ms-excel — a dependency-free
// .xls that preserves columns/formatting (no xlsx library in the project).
function toXls(rows: OrderReportRow[], title: string, cols: ReportColumnDef[], totals: Partial<OrderReportRow>): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const head = `<tr>${cols.map(c => `<th style="background:#EEF0FD;border:1px solid #ccc;padding:4px 8px;text-align:left">${esc(c.label)}</th>`).join('')}</tr>`
  const tv = rowValues(totals, cols)
  const labelAt = cols.findIndex(c => !c.financial)
  if (labelAt >= 0) tv[labelAt] = 'TOTAL'
  const foot = `<tr>${tv.map(v => `<td style="border:1px solid #ccc;padding:4px 8px;font-weight:700;background:#F7F7FB">${esc(v)}</td>`).join('')}</tr>`
  const body = rows.map(r => `<tr>${rowValues(r, cols).map(v => `<td style="border:1px solid #ddd;padding:4px 8px">${esc(v)}</td>`).join('')}</tr>`).join('') + foot
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${esc(title)}</x:Name></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table>${head}${body}</table></body></html>`
}

async function toPdf(rows: OrderReportRow[], title: string, sub: string, cols: ReportColumnDef[], totals: Partial<OrderReportRow>): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  // 22+ money columns do not fit on landscape Letter at a readable size, so the
  // page is sized to the columns rather than the columns squeezed to the page.
  // A wide PDF scrolls; an illegible one is useless.
  const M = 28
  const widths = cols.map(c => c.key === 'customerName' ? 118
    : c.key === 'location' ? 118
    : c.key === 'serviceType' ? 84
    : c.financial ? 74 : 62)
  const totalW = widths.reduce((a, b) => a + b, 0)
  const W = Math.max(792, totalW + M * 2), H = 612
  let page = doc.addPage([W, H])
  let y = H - M
  const DARK = rgb(0.10, 0.06, 0.16), GREY = rgb(0.4, 0.4, 0.45), BORDER = rgb(0.8, 0.8, 0.84)
  const trunc = (t: string, size: number, maxW: number) => { let s = t; while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1); return s.length < t.length ? s + '…' : t }

  page.drawText(title, { x: M, y: y - 4, size: 15, font: bold, color: DARK }); y -= 22
  page.drawText(sub, { x: M, y: y - 2, size: 9, font, color: GREY }); y -= 18

  const drawHeader = () => {
    page.drawRectangle({ x: M, y: y - 18, width: totalW, height: 18, color: rgb(0.93, 0.94, 0.99) })
    let x = M
    cols.forEach((c, i) => { page.drawText(trunc(c.label, 7, widths[i] - 6), { x: x + 4, y: y - 13, size: 7, font: bold, color: DARK }); x += widths[i] })
    y -= 18
  }
  drawHeader()
  for (const r of rows) {
    if (y < M + 20) { page = doc.addPage([W, H]); y = H - M; drawHeader() }
    let x = M
    rowValues(r, cols).forEach((v, i) => {
      page.drawText(trunc(String(v), 7.5, widths[i] - 6), { x: x + 4, y: y - 12, size: 7.5, font, color: DARK })
      x += widths[i]
    })
    page.drawLine({ start: { x: M, y: y - 17 }, end: { x: M + totalW, y: y - 17 }, thickness: 0.4, color: BORDER })
    y -= 17
  }
  // Totals row — FM sums its financial columns.
  if (y < M + 26) { page = doc.addPage([W, H]); y = H - M; drawHeader() }
  const tv = rowValues(totals, cols)
  const labelAt = cols.findIndex(c => !c.financial)
  if (labelAt >= 0) tv[labelAt] = 'TOTAL'
  page.drawRectangle({ x: M, y: y - 18, width: totalW, height: 18, color: rgb(0.97, 0.97, 0.99) })
  let tx = M
  tv.forEach((v, i) => { page.drawText(trunc(String(v), 7.5, widths[i] - 6), { x: tx + 4, y: y - 13, size: 7.5, font: bold, color: DARK }); tx += widths[i] })
  return doc.save()
}

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  // resolveDiscoScopeRef only resolves ctx.restaurantReference, which is always
  // '' for ordinary FM-authenticated sessions (only Disco-native sessions carry
  // it) — that silently 400'd Export Reports for every FM-backed restaurant.
  // FM sessions resolve their restaurant from the JWT itself via getRestaurantRef
  // (same fix as the menu-manager Items-column bug, same root cause).
  const ref = ctx.authType === 'disco' ? await resolveDiscoScopeRef(ctx) : (await getRestaurantRef()) || ''
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  const sp = req.nextUrl.searchParams
  const from = sp.get('from') || ''
  const to = sp.get('to') || ''
  const dateField = sp.get('dateField') === 'created' ? 'created' : 'order'
  const format = (['csv', 'xls', 'pdf'].includes(sp.get('format') || '') ? sp.get('format') : 'csv') as 'csv' | 'xls' | 'pdf'
  // Operator override for the subsidy column; it also auto-shows when any row is
  // non-zero, so this only matters for forcing a permanently-zero column visible.
  const forceSubsidy = sp.get('showSubsidy') === '1'
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required.' }, { status: 400 })

  try {
    // MULTI-LOCATION. FM prepends a Location column for a SYSTEM_ADMIN covering
    // more than one restaurant, so the scope is the caller's whole reach rather
    // than one ref. resolveDiscoGroupScope is the role gate: a plain ADMIN gets
    // its own location no matter how many grant rows exist.
    //
    // MUST NOT be scoped to visibility/archive status — an archived restaurant's
    // history must keep exporting. Archiving is not deletion.
    const scope = await resolveDiscoGroupScope(ctx)
    const refs = scope.unrestricted || scope.refs.size === 0 ? [ref] : [...new Set([ref, ...scope.refs])]
    const rows = await buildOrderReportRows({
      refs, from, to, dateField: dateField === 'created' ? 'created_at' : 'order_date',
    })

    // FAIL LOUDLY. The subsidy subtraction has never been exercised by a real
    // order — zero native orders carry one — so if the payout ever stops
    // reconciling against the row's own visible components, this refuses to
    // render rather than publishing a plausible wrong number. A quietly
    // misstated payout is the worst outcome available here.
    const broken = rows.map(r => ({ r, c: reconcileRow(r) })).filter(x => !x.c.ok)
    if (broken.length) {
      console.error('[reports/export] payout failed to reconcile:', broken.slice(0, 5).map(b => ({ order: b.r.orderId, expected: b.c.expected, got: b.r.totalDistributed, delta: b.c.delta })))
      return NextResponse.json({
        error: 'Report withheld: the payout figures did not reconcile.',
        description: `${broken.length} order(s) could not be reconciled — first: #${broken[0].r.orderId}. This has been logged. Email concierge@discocater.com.`,
      }, { status: 500 })
    }

    const multiLocation = new Set(rows.map(r => r.location)).size > 1
    const cols = activeColumns(rows, multiLocation, forceSubsidy)
    const totals = totalsRow(rows)

    const title = 'Orders Report'
    // "to" not "→" — pdf-lib's WinAnsi-encoded Helvetica can't draw that glyph
    // and throws, which made PDF export fail unconditionally on every request.
    const sub = `${dateField === 'created' ? 'Created' : 'Order'} date ${from} to ${to} · ${rows.length} order${rows.length === 1 ? '' : 's'}`
    const fnbase = `orders-report_${dateField}_${from}_${to}`

    if (format === 'csv') {
      return new NextResponse(toCsv(rows, cols, totals), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': contentDisposition('attachment', `${fnbase}.csv`) } })
    }
    if (format === 'xls') {
      return new NextResponse(toXls(rows, title, cols, totals), { headers: { 'Content-Type': 'application/vnd.ms-excel; charset=utf-8', 'Content-Disposition': contentDisposition('attachment', `${fnbase}.xls`) } })
    }
    const pdf = await toPdf(rows, title, sub, cols, totals)
    return new NextResponse(Buffer.from(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition('attachment', `${fnbase}.pdf`) } })
  } catch (e) {
    console.error('[reports/export] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to generate report' }, { status: 500 })
  }
}
