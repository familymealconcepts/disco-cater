// Server-side order PDF (pure-JS via pdf-lib — no native deps, serverless-safe).
// Used for: the PDF attached to restaurant confirmation + order-change emails,
// and the downloadable link in the restaurant SMS. Loads a normalized order by
// its Disco reference from Neon (mirrors the fields the email/notifications use).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { sql } from '../db'
import { formatTimeWindow } from '../utils/deliveryTimeWindow'

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}
function money(n: number): string { return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}` }
function fmtDate(v: unknown): string {
  const iso = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10)
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y) return iso
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
}

export interface OrderPdfData {
  orderNumber: string
  reference: string
  restaurantName: string
  restaurantPhone?: string
  restaurantAddress?: string
  customerName: string
  customerEmail?: string
  customerPhone?: string
  companyName?: string
  orderService: string
  orderDate: string
  orderTime: string
  orderReceived: string
  deliveryAddress?: string
  persons?: number
  note?: string
  taxExemptId?: string
  items: { name: string; quantity: number; price: number; note?: string }[]
  subtotal: number
  serviceCharge: number
  taxes: number
  fees: number
  deliveryFee: number
  tip: number
  promo: number
  refund: number
  total: number
}

// Load + normalize an order by its Disco reference. Returns null when not found.
// Mirrors the money/total resolution in lib/order-notifications.ts so the PDF
// matches the email/portal/Slack figures (native orders store totals on
// disco_orders; FM-mirrored orders on disco_sale_transactions).
export async function loadOrderPdfData(orderRef: string): Promise<OrderPdfData | null> {
  const orders = (await sql`
    SELECT id, reference, order_number, order_type, order_date, order_time, delivery_time_window, note, created_at,
           customer_email, customer_first_name, customer_last_name, customer_phone,
           delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
           restaurant_reference, restaurant_name, tax_exempt_id, tips,
           subtotal, total, fee, refund, persons, company_name
    FROM disco_orders WHERE reference = ${orderRef}::uuid OR fm_order_reference = ${orderRef}::uuid
    LIMIT 1
  `) as Record<string, unknown>[]
  if (orders.length === 0) return null
  const o = orders[0]
  const orderId = o.id as number

  const txns = (await sql`
    SELECT subtotal, total, fee, service_charge, state_tax, local_tax, other_tax,
           tips_in_price, own_delivery_fee, third_party_delivery_fee, discount
    FROM disco_sale_transactions WHERE order_id = ${orderId} AND transaction_type = 'ORIGINAL' LIMIT 1
  `) as Record<string, unknown>[]
  const t = txns[0] ?? {}
  const hasTxn = txns.length > 0

  const restRef = String(o.restaurant_reference ?? '')
  let cacheName = '', cachePhone = '', cacheAddress = '', cacheTimezone = ''
  try {
    const rc = (await sql`SELECT name, address, phone, timezone FROM disco_restaurant_cache WHERE restaurant_reference = ${restRef} LIMIT 1`) as { name: string | null; address: string | null; phone: string | null; timezone: string | null }[]
    cacheName = rc[0]?.name || ''
    cachePhone = rc[0]?.phone || ''
    cacheAddress = rc[0]?.address || ''
    cacheTimezone = rc[0]?.timezone || ''
  } catch { /* best-effort */ }

  let stripeTotal = 0
  try {
    const sp = (await sql`SELECT MAX(total) AS total FROM disco_stripe_payments WHERE order_reference = ${String(o.reference ?? '')}::uuid AND total IS NOT NULL AND total > 0`) as { total: string | number | null }[]
    stripeTotal = num(sp[0]?.total)
  } catch { /* best-effort */ }

  const items = (await sql`
    SELECT name, quantity, price_per_unit, notes FROM disco_order_items WHERE order_id = ${orderId} ORDER BY id
  `) as Record<string, unknown>[]

  const isDelivery = String(o.order_type) === 'DELIVERY'
  const cityStateZip = [o.delivery_city, [o.delivery_state, o.delivery_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const deliveryAddress = isDelivery
    ? [o.delivery_address_line1, o.delivery_address_line2, cityStateZip].filter(Boolean).join(', ') || undefined
    : undefined

  const subtotal = hasTxn ? num(t.subtotal) : num(o.subtotal)
  const serviceCharge = num(t.service_charge)
  const deliveryFee = num(t.own_delivery_fee) + num(t.third_party_delivery_fee)
  const tip = num(t.tips_in_price) || num(o.tips)
  const promo = num(t.discount)
  const refund = num(o.refund)
  const total = hasTxn ? num(t.total) : (num(o.total) || stripeTotal)
  const fees = hasTxn ? num(t.fee) : num(o.fee)
  const taxes = hasTxn
    ? num(t.state_tax) + num(t.local_tax) + num(t.other_tax)
    : Math.max(0, total - subtotal - fees - serviceCharge - tip - deliveryFee + promo)

  return {
    orderNumber: String(o.order_number ?? ''),
    reference: String(o.reference ?? ''),
    restaurantName: cacheName || (o.restaurant_name ? String(o.restaurant_name) : '') || 'Restaurant',
    restaurantPhone: cachePhone || undefined,
    restaurantAddress: cacheAddress || undefined,
    customerName: [o.customer_first_name, o.customer_last_name].filter(Boolean).join(' ') || '—',
    customerEmail: o.customer_email ? String(o.customer_email) : undefined,
    customerPhone: o.customer_phone ? String(o.customer_phone) : undefined,
    companyName: o.company_name ? String(o.company_name) : undefined,
    orderService: String(o.order_type ?? ''),
    orderDate: fmtDate(o.order_date),
    orderTime: formatTimeWindow(String(o.order_time ?? ''), o.delivery_time_window as string | null, isDelivery),
    // "Received on …" in the restaurant's local timezone (was UTC, which read
    // ~4h ahead for an EDT restaurant). Falls back to America/New_York.
    orderReceived: o.created_at ? new Date(o.created_at as string).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: cacheTimezone || 'America/New_York' }) : '',
    deliveryAddress,
    persons: o.persons != null && Number(o.persons) > 0 ? Number(o.persons) : undefined,
    note: o.note ? String(o.note) : undefined,
    taxExemptId: o.tax_exempt_id ? String(o.tax_exempt_id) : undefined,
    items: items.map((it) => ({ name: String(it.name ?? ''), quantity: num(it.quantity) || 1, price: num(it.price_per_unit), note: it.notes ? String(it.notes) : undefined })),
    subtotal, serviceCharge, taxes, fees, deliveryFee, tip, promo, refund, total,
  }
}

const GRAD = rgb(0.42, 0.43, 0.98)      // #6B6EF9 (disco wordmark)
const DARK = rgb(0.10, 0.06, 0.16)      // #1A1028
const GREY = rgb(0.42, 0.42, 0.47)
const FAINT = rgb(0.60, 0.60, 0.66)     // uppercase micro-labels
const HAIR = rgb(0.90, 0.90, 0.93)
const HAIR_STRONG = rgb(0.84, 0.84, 0.88)

// Render the order as an auto-paginating PDF. Layout: Disco's modern styling with
// FamilyMeal's field set + order — "Received on", an ORDER DETAILS | {SERVICE} TIME
// row, and side-by-side STORE | CUSTOMER blocks (Option B).
export async function renderOrderPdf(d: OrderPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const W = 612, H = 792, M = 48, RIGHT = W - M
  let page = doc.addPage([W, H])
  let y = H - M

  const brk = (need = 40) => { if (y < M + need) { page = doc.addPage([W, H]); y = H - M } }
  const put = (t: string, x: number, atY: number, size: number, f: PDFFont = font, color = DARK) => page.drawText(t, { x, y: atY, size, font: f, color })
  const putR = (t: string, atY: number, size: number, f: PDFFont = font, color = DARK) => page.drawText(t, { x: RIGHT - f.widthOfTextAtSize(t, size), y: atY, size, font: f, color })
  const trunc = (t: string, f: PDFFont, size: number, maxW: number) => {
    if (f.widthOfTextAtSize(t, size) <= maxW) return t
    let s = t
    while (s.length > 1 && f.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1)
    return s + '…'
  }
  const rule = (strong = false) => { brk(); page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: strong ? 0.9 : 0.6, color: strong ? HAIR_STRONG : HAIR }); y -= 16 }

  const colGap = 28
  const colW = (RIGHT - M - colGap) / 2
  const leftX = M, rightX = M + colW + colGap
  type Ln = { t: string; b?: boolean; s?: number; c?: ReturnType<typeof rgb> }
  const twoCol = (leftLabel: string, leftLines: Ln[], rightLabel: string, rightLines: Ln[]) => {
    brk(90)
    const top = y
    put(leftLabel.toUpperCase(), leftX, top, 8.5, bold, FAINT)
    put(rightLabel.toUpperCase(), rightX, top, 8.5, bold, FAINT)
    const draw = (lines: Ln[], x: number) => {
      let ly = top - 16
      for (const l of lines) { const s = l.s ?? 11, f = l.b ? bold : font; put(trunc(l.t, f, s, colW), x, ly, s, f, l.c ?? DARK); ly -= s + 5 }
      return ly
    }
    y = Math.min(draw(leftLines, leftX), draw(rightLines, rightX)) - 2
  }

  // ── Header: wordmark, order number, "Received on …" ──
  put('disco cater', M, y, 16, bold, GRAD); y -= 27
  put(`Order #${d.orderNumber}`, M, y, 22, bold, DARK); y -= 19
  if (d.orderReceived) { put(`Received on ${d.orderReceived}`, M, y, 10, font, GREY); y -= 6 }
  y -= 10; rule()

  // ── ORDER DETAILS | {SERVICE} TIME ──
  const isDelivery = (d.orderService || '').toUpperCase() === 'DELIVERY'
  const timeLabel = isDelivery ? 'Delivery Pick-Up Time' : `${d.orderService || 'Pickup'} Time`
  const detailLines: Ln[] = [{ t: d.orderService || 'Pickup', b: true, s: 13 }]
  if (d.persons) detailLines.push({ t: `Headcount: ${d.persons}`, s: 10, c: GREY })
  if (d.note) detailLines.push({ t: d.note, s: 10, c: GREY })
  const timeLines: Ln[] = []
  if (d.orderDate) timeLines.push({ t: d.orderDate, b: true, s: 13 })
  if (d.orderTime) timeLines.push({ t: d.orderTime, s: 11, c: GREY })
  twoCol('Order details', detailLines, timeLabel, timeLines)
  rule()

  // ── STORE | CUSTOMER ──
  const storeLines: Ln[] = [{ t: d.restaurantName, b: true, s: 12 }]
  if (d.restaurantAddress) storeLines.push({ t: d.restaurantAddress, s: 10, c: GREY })
  if (d.restaurantPhone) storeLines.push({ t: d.restaurantPhone, s: 10, c: GREY })
  const custLines: Ln[] = [{ t: d.customerName, b: true, s: 12 }]
  if (d.companyName) custLines.push({ t: d.companyName, s: 10, c: GREY })
  if (d.customerEmail) custLines.push({ t: d.customerEmail, s: 10, c: GREY })
  if (d.customerPhone) custLines.push({ t: d.customerPhone, s: 10, c: GREY })
  if (d.deliveryAddress) custLines.push({ t: d.deliveryAddress, s: 10, c: GREY })
  twoCol('Store', storeLines, 'Customer', custLines)
  rule()

  // ── Items ──
  brk(); put('ITEMS', M, y, 8.5, bold, FAINT); y -= 17
  const itemMaxW = RIGHT - M - 70
  for (const it of d.items) {
    brk()
    const rowY = y
    put(trunc(`(${it.quantity})  ${it.name}`, font, 11, itemMaxW), M, rowY, 11, font, DARK)
    putR(money(it.price * it.quantity), rowY, 11, font, DARK)
    y -= 16
    if (it.note) { put(trunc(`    ${it.note}`, font, 9, RIGHT - M), M, y, 9, font, GREY); y -= 12 }
  }
  y -= 4; rule(true)

  // ── Totals (right half of the page, label left / value right) ──
  const totalRow = (label: string, val: number, strong = false) => {
    brk()
    const f = strong ? bold : font, size = strong ? 13 : 11
    const rowY = y
    put(label, rightX, rowY, size, f, strong ? DARK : GREY)
    putR(money(val), rowY, size, f, DARK)
    y -= strong ? 20 : 16
  }
  totalRow('Subtotal', d.subtotal)
  if (d.serviceCharge) totalRow('Service charge', d.serviceCharge)
  if (d.deliveryFee) totalRow('Delivery', d.deliveryFee)
  if (d.taxes) totalRow('Taxes', d.taxes)
  if (d.fees) totalRow('Fees', d.fees)
  if (d.tip) totalRow('Tip', d.tip)
  if (d.promo) totalRow('Discount', -Math.abs(d.promo))
  if (d.refund) totalRow('Refund', -Math.abs(d.refund))
  brk(); page.drawLine({ start: { x: rightX, y: y + 6 }, end: { x: RIGHT, y: y + 6 }, thickness: 0.9, color: HAIR_STRONG }); y -= 2
  totalRow('Total', d.total, true)

  if (d.taxExemptId) { y -= 6; put(`Tax Exempt #: ${d.taxExemptId}`, M, y, 10, bold, DARK); y -= 14 }

  // ── Footer ──
  y -= 12; brk()
  put(`Order ID: ${d.orderNumber}`, M, y, 10, font, GREY)
  putR('Thank you for your order', y, 10, font, FAINT)

  return doc.save()
}

// Convenience: load + render by reference. Returns null when the order isn't found.
export async function buildOrderPdfByReference(orderRef: string): Promise<Uint8Array | null> {
  const data = await loadOrderPdfData(orderRef)
  if (!data) return null
  return renderOrderPdf(data)
}
