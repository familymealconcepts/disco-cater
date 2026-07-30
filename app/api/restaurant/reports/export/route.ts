import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { sql } from '../../../../../lib/db'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const money = (n: number) => `$${n.toFixed(2)}`

const COLUMNS = ['Order #', 'Order Date', 'Created Date', 'Customer', 'Type', 'Status', 'Source', 'Subtotal', 'Tips', 'Total'] as const

interface Row { number: string; orderDate: string; createdDate: string; customer: string; type: string; status: string; source: string; subtotal: string; tips: string; total: string }

function rowValues(r: Row): string[] {
  return [r.number, r.orderDate, r.createdDate, r.customer, r.type, r.status, r.source, r.subtotal, r.tips, r.total]
}

// ── Formatters ───────────────────────────────────────────────────────────────
function toCsv(rows: Row[]): string {
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const lines = [COLUMNS.join(',')]
  for (const r of rows) lines.push(rowValues(r).map(esc).join(','))
  return lines.join('\r\n')
}

// Excel opens an HTML <table> served as application/vnd.ms-excel — a dependency-free
// .xls that preserves columns/formatting (no xlsx library in the project).
function toXls(rows: Row[], title: string): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const head = `<tr>${COLUMNS.map(c => `<th style="background:#EEF0FD;border:1px solid #ccc;padding:4px 8px;text-align:left">${esc(c)}</th>`).join('')}</tr>`
  const body = rows.map(r => `<tr>${rowValues(r).map(v => `<td style="border:1px solid #ddd;padding:4px 8px">${esc(v)}</td>`).join('')}</tr>`).join('')
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${esc(title)}</x:Name></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table>${head}${body}</table></body></html>`
}

async function toPdf(rows: Row[], title: string, sub: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const W = 792, H = 612, M = 32 // landscape Letter
  // Column widths tuned to the content.
  const widths = [58, 66, 66, 150, 54, 74, 54, 60, 48, 60]
  const totalW = widths.reduce((a, b) => a + b, 0)
  let page = doc.addPage([W, H])
  let y = H - M
  const DARK = rgb(0.10, 0.06, 0.16), GREY = rgb(0.4, 0.4, 0.45), BORDER = rgb(0.8, 0.8, 0.84)
  const trunc = (t: string, size: number, maxW: number) => { let s = t; while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1); return s.length < t.length ? s + '…' : t }

  page.drawText(title, { x: M, y: y - 4, size: 15, font: bold, color: DARK }); y -= 22
  page.drawText(sub, { x: M, y: y - 2, size: 9, font, color: GREY }); y -= 18

  const drawHeader = () => {
    page.drawRectangle({ x: M, y: y - 18, width: totalW, height: 18, color: rgb(0.93, 0.94, 0.99) })
    let x = M
    COLUMNS.forEach((c, i) => { page.drawText(c, { x: x + 4, y: y - 13, size: 8, font: bold, color: DARK }); x += widths[i] })
    y -= 18
  }
  drawHeader()
  for (const r of rows) {
    if (y < M + 20) { page = doc.addPage([W, H]); y = H - M; drawHeader() }
    let x = M
    rowValues(r).forEach((v, i) => {
      page.drawText(trunc(String(v), 8, widths[i] - 6), { x: x + 4, y: y - 12, size: 8, font, color: DARK })
      x += widths[i]
    })
    page.drawLine({ start: { x: M, y: y - 17 }, end: { x: M + totalW, y: y - 17 }, thickness: 0.4, color: BORDER })
    y -= 17
  }
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
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required.' }, { status: 400 })

  try {
    // Filter on the requested date field. created_at is a timestamp → compare on its
    // date; order_date is a date. Inclusive range.
    const rowsRaw = dateField === 'created'
      ? (await sql`
          SELECT order_number, to_char(order_date,'YYYY-MM-DD') AS order_date, to_char(created_at,'YYYY-MM-DD') AS created_date,
                 customer_first_name, customer_last_name, order_type, order_status, source_of_order, subtotal, tips, total
          FROM disco_orders
          WHERE restaurant_reference = ${ref}::uuid AND is_deleted = false
            AND created_at::date >= ${from}::date AND created_at::date <= ${to}::date
          ORDER BY created_at DESC`)
      : (await sql`
          SELECT order_number, to_char(order_date,'YYYY-MM-DD') AS order_date, to_char(created_at,'YYYY-MM-DD') AS created_date,
                 customer_first_name, customer_last_name, order_type, order_status, source_of_order, subtotal, tips, total
          FROM disco_orders
          WHERE restaurant_reference = ${ref}::uuid AND is_deleted = false
            AND order_date >= ${from}::date AND order_date <= ${to}::date
          ORDER BY order_date DESC`) as Array<Record<string, unknown>>

    const rows: Row[] = (rowsRaw as Array<Record<string, unknown>>).map(r => ({
      number: String(r.order_number ?? ''),
      orderDate: String(r.order_date ?? ''),
      createdDate: String(r.created_date ?? ''),
      customer: [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ') || '—',
      type: String(r.order_type ?? ''),
      status: String(r.order_status ?? ''),
      source: r.source_of_order === 'DISCO' ? 'Marketplace' : 'Direct',
      subtotal: money(num(r.subtotal)),
      tips: money(num(r.tips)),
      total: money(num(r.total)),
    }))

    const title = 'Orders Report'
    // "to" not "→" — pdf-lib's WinAnsi-encoded Helvetica can't draw that glyph
    // and throws, which made PDF export fail unconditionally on every request.
    const sub = `${dateField === 'created' ? 'Created' : 'Order'} date ${from} to ${to} · ${rows.length} order${rows.length === 1 ? '' : 's'}`
    const fnbase = `orders-report_${dateField}_${from}_${to}`

    if (format === 'csv') {
      return new NextResponse(toCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fnbase}.csv"` } })
    }
    if (format === 'xls') {
      return new NextResponse(toXls(rows, title), { headers: { 'Content-Type': 'application/vnd.ms-excel; charset=utf-8', 'Content-Disposition': `attachment; filename="${fnbase}.xls"` } })
    }
    const pdf = await toPdf(rows, title, sub)
    return new NextResponse(Buffer.from(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fnbase}.pdf"` } })
  } catch (e) {
    console.error('[reports/export] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to generate report' }, { status: 500 })
  }
}
