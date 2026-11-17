// Export Orders (restaurant portal → Orders → Active / History), built from FamilyMeal's own code
// (Peter, 2026-11-17). FamilyMeal's pop-up (familymeal_client_ui shared/export-orders) offers three things:
//
//   SUMMARY  "Print Order Summary .PDF" — print-template.component.ts printPDFUpdates(): a tabloid page, one
//            compact block per order, stacked, opened straight into the print dialog (jsPDF autoPrint).
//   DETAILS  "Print Order Details .PDF" — FamilyMeal's /public-api/order/pdf: every order's own order PDF in
//            one file. Here that is renderOrderPdf, the wrapping layout, so nothing is cut off.
//   XLSX     "Export .XLSX" — all-orders-template.component.html: one row per order, eight columns.
//
// FOLLOWS FAMILYMEAL'S CODE, not the older "Order Summary Print" doc: ORDER TIME and a PICKUP / DELIVERY
// PICKUP drop-off line rather than PREPARE BY, no TYPE line, and the service charge, promo and refund lines.
// Where we deliberately differ (Peter, 2026-11-17): search applies (FamilyMeal's exports ignore the box),
// names print "Bob Mulry" (FamilyMeal joins them with a hyphen), the XLSX file name has the right month
// (FamilyMeal's is one behind) and "Received on" is when the order was placed (FamilyMeal printed its date).
// Data FamilyMeal has and Disco does not: the restaurant fee-category name for a FamilyMeal order's service
// charge (its fallback label "Service Charges" is used) and the purchase type (every Disco order is a menu
// order, which FamilyMeal labels "Items").
//
// Money comes from loadOrderPdfData, the same figures as the order PDF, so the three exports agree with it.
import ExcelJS from 'exceljs'
import { PDFDocument, PDFName, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { sql } from '../db'
import { pdfSafe } from '../pdf-text'
import { formatTime12 } from '../utils/time'
import { loadOrderPdfData, renderOrderPdf, wrapPdfText, type OrderPdfData } from './order-pdf'

export const EXPORT_FORMATS = ['SUMMARY', 'DETAILS', 'XLSX'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** One order, as the three exports need it: the order PDF's data plus the few raw fields FamilyMeal prints. */
export type ExportOrder = {
  pdf: OrderPdfData
  firstName: string
  lastName: string
  orderStatus: string
  orderType: string
  deliveryType: string | null
  orderDate: string // YYYY-MM-DD
  orderTime: string // HH:MM[:SS]
  dropOffTime: string | null
  placedAt: string | null // ISO
  timezone: string
  purchaseType: string | null
  serviceChargeName: string | null
}

// ── FamilyMeal's labels (fm-types.pipe.ts, order-status.constant.ts) ─────────────────────────────────

/** FamilyMeal's fmTypes pipe, as the exports call it (not uppercase, not order history). */
export function fmType(type: string | null | undefined): string {
  if (!type) return ''
  if (type === 'CLASSICS_MEAL_PACKAGES') return 'Items, Modifiers'
  if (type === 'MEAL_PACKAGES') return 'Items'
  if (type === 'OWN_DELIVERY') return 'Self-Delivery'
  if (type === 'COMPLETED') return 'Complete'
  if (type === 'CANCELED') return 'Cancel'
  if (['NASH_DELIVERY', 'DOOR_DASH_DELIVERY', 'DLIVRD_DELIVERY'].includes(type)) return 'Third-Party Delivery'
  return type.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

const STATUS_LABEL: Record<string, string> = {
  DUE: 'Due', COMPLETED: 'Completed', REOPEN: 'Reopened', REFUND: 'Refunded', REFUNDED: 'Refunded', PARTIAL_REFUND: 'Partial refunded',
  CANCELED: 'Canceled', CANCELLED: 'Canceled', EXPIRED: 'Expired', RESERVED: 'Reserved', VOID: 'Voided', VOIDED: 'Voided',
  PAID: 'Paid', UNPAID: 'Unpaid', PARTIALLY_PAID: 'Partially Paid',
}
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s

/** FamilyMeal's Service: the delivery kind for a delivery, else the order type (PDF: as stored; XLSX: title case). */
function serviceOf(o: ExportOrder, titleCase: boolean): string {
  if (o.orderType === 'DELIVERY') return fmType(o.deliveryType || 'DELIVERY')
  return titleCase ? o.orderType.charAt(0) + o.orderType.slice(1).toLowerCase() : o.orderType
}

const fullName = (o: ExportOrder) => [o.firstName, o.lastName].map((s) => s.trim()).filter(Boolean).join(' ')
const money = (n: number) => `$${(Number.isFinite(n) ? n : 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** moment's 'dddd, MMMM DD, YYYY'. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y) return iso
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`
}
/** 'MM/dd/YY'. */
const shortDate = (iso: string) => { const [y, m, d] = iso.split('-'); return y ? `${m}/${d}/${y.slice(2)}` : iso }

/** "Received on MM/DD/YY at h:mm AM", in the restaurant's zone, from when the order was placed. */
export function receivedOn(placedAt: string | null, tz: string): string {
  if (!placedAt) return ''
  const dt = new Date(placedAt)
  if (Number.isNaN(dt.getTime())) return ''
  const date = dt.toLocaleDateString('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', year: '2-digit' })
  const time = dt.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
  return `Received on ${date} at ${time}`
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────────────

async function loadOne(ref: string): Promise<ExportOrder | null> {
  const [pdf, rows] = await Promise.all([
    loadOrderPdfData(ref),
    sql`
      SELECT o.customer_first_name, o.customer_last_name, o.order_status, o.order_type, o.delivery_type,
             to_char(o.order_date, 'YYYY-MM-DD') AS order_date, o.order_time::text AS order_time,
             o.order_drop_off_time::text AS drop_off, COALESCE(o.placed_at, o.created_at) AS placed_at,
             o.purchase_type, rc.timezone, m.service_charge_name
        FROM disco_orders o
        LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
        LEFT JOIN disco_menus m ON m.reference::text = o.menu_reference::text
       WHERE (o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid) AND o.is_deleted = false
       LIMIT 1
    ` as Promise<Record<string, unknown>[]>,
  ])
  const r = rows[0]
  if (!pdf || !r) return null
  const str = (v: unknown) => (v == null ? '' : String(v))
  return {
    pdf,
    firstName: str(r.customer_first_name), lastName: str(r.customer_last_name),
    orderStatus: str(r.order_status), orderType: str(r.order_type) || 'PICKUP', deliveryType: r.delivery_type ? str(r.delivery_type) : null,
    orderDate: str(r.order_date), orderTime: str(r.order_time), dropOffTime: r.drop_off ? str(r.drop_off) : null,
    placedAt: r.placed_at ? new Date(r.placed_at as string).toISOString() : null,
    timezone: str(r.timezone) || 'America/New_York',
    purchaseType: r.purchase_type ? str(r.purchase_type) : null,
    serviceChargeName: r.service_charge_name ? str(r.service_charge_name) : null,
  }
}

/** Every order, in the order given, a few at a time. Orders that cannot be loaded are skipped. */
export async function loadExportOrders(refs: string[], concurrency = 6): Promise<ExportOrder[]> {
  const out: (ExportOrder | null)[] = new Array(refs.length).fill(null)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, async () => {
    while (next < refs.length) { const i = next++; out[i] = await loadOne(refs[i]).catch(() => null) }
  }))
  return out.filter((o): o is ExportOrder => !!o)
}

// ── SUMMARY PDF (print-template.component.ts printPDFUpdates) ───────────────────────────────────────

const TABLOID: [number, number] = [792, 1224]
const TOP = 45, BOTTOM = 45, LH = 12, SIZE = 8

export async function renderSummaryPdf(orders: ExportOrder[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const H = TABLOID[1]
  let page: PDFPage = doc.addPage(TABLOID)
  let y = TOP // distance from the top, as jsPDF counts it
  const newPage = () => { page = doc.addPage(TABLOID); y = TOP }
  const room = () => H - BOTTOM - y
  const text = (t: string, x: number, f: PDFFont = font) => page.drawText(pdfSafe(t), { x, y: H - y, size: SIZE, font: f, color: rgb(0, 0, 0) })
  const line = (grey: number, width = 1) => page.drawLine({ start: { x: 135, y: H - (y + 5) }, end: { x: 650, y: H - (y + 5) }, thickness: width, color: rgb(grey, grey, grey) })
  const wrap = (t: string, x: number, right: number, keep = '') => wrapPdfText(t, font, SIZE, right - x, keep)
  /** One labelled row, its value wrapped up to `right`; each extra line is one more row. */
  type Row = { label?: string; lx?: number; value: string[]; vx: number; label2?: string; l2x?: number; value2?: string; v2x?: number; boldValue?: boolean }

  for (const o of orders) {
    const d = o.pdf
    // ── The block, as rows, so its height is known before it is drawn ─────────────────────────────
    const rows: (Row | { gap: number; rule?: [number, number] })[] = []
    const push = (r: Row) => r.value.forEach((v, i) => rows.push(i ? { value: [v], vx: r.vx, boldValue: r.boldValue } : { ...r, value: [v] }))
    rows.push({ gap: 12 - LH })
    push({ label: 'CUSTOMER NAME:', lx: 175, value: wrap(fullName(o), 252, 447), vx: 252, label2: 'ORDER ID:', l2x: 455, value2: d.orderNumber, v2x: 500 })
    push({ label: 'DATE:', lx: 175, value: [o.orderDate ? longDate(o.orderDate) : ''], vx: 202, label2: 'SERVICE:', l2x: 455, value2: serviceOf(o, false), v2x: 497 })
    push({ label: 'ORDER TIME:', lx: 175, value: [o.orderTime ? formatTime12(o.orderTime) : ''], vx: 232 })
    if (o.dropOffTime) {
      const del = o.orderType === 'DELIVERY'
      push({ label: del ? 'DELIVERY PICKUP:' : 'PICKUP:', lx: 175, value: [formatTime12(o.dropOffTime)], vx: del ? 252 : 212 })
    }
    if (d.deliveryAddress) push({ label: 'DELIVERY ADDRESS:', lx: 175, value: wrap(d.deliveryAddress, 265, 650), vx: 265 })
    rows.push({ gap: 5, rule: [0.565, 1] }, { gap: 5 })
    d.items.forEach((it, i) => {
      push({ value: wrap(`(${it.quantity}) ${it.name}`, 175, 447), vx: 175, label2: '', l2x: 455, value2: money(it.price * it.quantity), v2x: 455 })
      for (const a of it.addOns ?? []) push({ value: wrap(`+ (${a.quantity}) ${a.name.trim()} -`, 195, 650, money(a.price * a.quantity)), vx: 195 })
      if (it.note) push({ value: wrap(it.note, 195, 650), vx: 195 })
      rows.push({ gap: 5 })
      if (i !== d.items.length - 1) rows.push({ gap: 5, rule: [0.827, 1] })
    })
    rows.push({ gap: 5, rule: [0.565, 1] })
    const total = (label: string, value: string, b = false) => push({ label, lx: 338, value: [value], vx: 455, boldValue: b })
    total('Subtotal:', money(d.subtotal))
    if (d.serviceCharge) total(o.serviceChargeName || 'Service Charges', money(d.serviceCharge))
    total('Taxes & Fees:', d.taxes === null ? 'Unavailable' : money(d.fees + d.taxes))
    if (d.deliveryFee) total('Delivery Fee:', money(d.deliveryFee))
    total('Tip:', money(d.tip))
    if (d.promo) total('Promo:', money(d.promo))
    if (d.refund) total('Refund:', money(d.refund))
    total('Total:', money(d.total), true)
    rows.push({ gap: 5, rule: [0, 2] }, { gap: 5 })

    // ── Draw: the block moves to a new page when it fits there and not here; a block taller than a page
    //    flows across pages line by line, so nothing is ever cut off. ─────────────────────────────────
    const height = rows.reduce((a, r) => a + ('gap' in r ? r.gap : LH), 0)
    if (height > room() && height <= H - TOP - BOTTOM && y > TOP) newPage()
    for (const r of rows) {
      if ('gap' in r) { if (r.rule) line(r.rule[0], r.rule[1]); y += r.gap; continue }
      y += LH
      if (room() < 0) { newPage(); y += LH }
      if (r.label) text(r.label, r.lx!, r.boldValue || r.lx === 175 ? bold : font)
      text(r.value[0], r.vx, r.boldValue ? bold : font)
      if (r.label2) text(r.label2, r.l2x!, bold)
      if (r.value2) text(r.value2, r.v2x!, font)
    }
  }
  // FamilyMeal's doc.autoPrint(): open straight into the print dialog, where the viewer honours it.
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ Type: 'Action', S: 'Named', N: 'Print' }))
  return doc.save()
}

// ── DETAILS PDF (every order's own PDF, one file) ───────────────────────────────────────────────────

export async function renderDetailsPdf(orders: ExportOrder[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const o of orders) {
    const one = await PDFDocument.load(await renderOrderPdf(o.pdf))
    for (const p of await out.copyPages(one, one.getPageIndices())) out.addPage(p)
  }
  return out.save()
}

// ── XLSX (all-orders-template.component.html) ───────────────────────────────────────────────────────

export const XLSX_COLUMNS = ['Order', 'Prepare by', 'Drop off time', 'Service', 'Items', 'Type', 'Total', 'Status'] as const

/** The Items cell, FamilyMeal's text: "Name - 2 ( Option- 1, ), Other - 1". */
export function itemsCell(items: OrderPdfData['items']): string {
  return items.map((m) => `${m.name} - ${m.quantity}${m.addOns?.length ? ` ( ${m.addOns.map((a) => `${a.name.trim()}- ${a.quantity},`).join(' ')} )` : ''}`).join(', ')
}

export function xlsxRow(o: ExportOrder): (string | number)[] {
  return [
    [fullName(o), `Order ID: ${o.pdf.orderNumber}`, receivedOn(o.placedAt, o.timezone)].filter(Boolean).join('\n'),
    [o.orderTime ? formatTime12(o.orderTime) : '', o.orderDate ? shortDate(o.orderDate) : ''].filter(Boolean).join('\n'),
    o.dropOffTime ? formatTime12(o.dropOffTime) : '',
    serviceOf(o, true),
    itemsCell(o.pdf.items),
    fmType(o.purchaseType || 'MEAL_PACKAGES'),
    o.pdf.total,
    statusLabel(o.orderStatus),
  ]
}

export async function renderXlsx(orders: ExportOrder[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Disco Cater'
  const ws = wb.addWorksheet('Orders')
  ws.columns = XLSX_COLUMNS.map((header, i) => ({ header, width: [34, 14, 14, 20, 60, 10, 12, 12][i] }))
  ws.getRow(1).font = { bold: true }
  for (const o of orders) ws.addRow(xlsxRow(o))
  ws.getColumn(7).numFmt = '$#,##0.00'
  ws.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'top', wrapText: true } })
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

// ── File names (FamilyMeal's, with the month fixed) ─────────────────────────────────────────────────

const mmddyyyy = (iso: string) => { const [y, m, d] = iso.split('-'); return `${m}${d}${y}` }
export function exportFileName(format: ExportFormat, orders: ExportOrder[], f: { fromDate?: string; toDate?: string; desc: boolean; today: string }): string {
  if (format === 'XLSX') return `OrderSummary_${mmddyyyy(f.today)}.xlsx`
  if (format === 'DETAILS') {
    const s = (iso: string) => { const [y, m, d] = iso.split('-'); return `${m}${d}${y.slice(2)}` }
    return f.fromDate && f.toDate ? `OrderDetails_${s(f.fromDate)}-${s(f.toDate)}.pdf` : 'OrderDetails.pdf'
  }
  const days = orders.map((o) => o.orderDate).filter(Boolean).sort()
  if (!days.length) return 'OrderSummary.pdf'
  const from = mmddyyyy(days[0]), to = mmddyyyy(days[days.length - 1])
  return `OrderSummary_${f.fromDate && !f.toDate ? from : f.desc ? `${to}-${from}` : `${from}-${to}`}.pdf`
}
