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
  let cacheName = '', cachePhone = '', cacheAddress = ''
  try {
    const rc = (await sql`SELECT name, address, phone FROM disco_restaurant_cache WHERE restaurant_reference = ${restRef} LIMIT 1`) as { name: string | null; address: string | null; phone: string | null }[]
    cacheName = rc[0]?.name || ''
    cachePhone = rc[0]?.phone || ''
    cacheAddress = rc[0]?.address || ''
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
    orderReceived: o.created_at ? new Date(o.created_at as string).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) : '',
    deliveryAddress,
    persons: o.persons != null && Number(o.persons) > 0 ? Number(o.persons) : undefined,
    note: o.note ? String(o.note) : undefined,
    taxExemptId: o.tax_exempt_id ? String(o.tax_exempt_id) : undefined,
    items: items.map((it) => ({ name: String(it.name ?? ''), quantity: num(it.quantity) || 1, price: num(it.price_per_unit), note: it.notes ? String(it.notes) : undefined })),
    subtotal, serviceCharge, taxes, fees, deliveryFee, tip, promo, refund, total,
  }
}

const GRAD = rgb(0.42, 0.43, 0.98)  // #6B6EF9
const DARK = rgb(0.10, 0.06, 0.16)  // #1A1028
const GREY = rgb(0.42, 0.42, 0.42)

// Render the order as a single-page (auto-paginating) PDF and return the bytes.
export async function renderOrderPdf(d: OrderPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  let page = doc.addPage([612, 792]) // US Letter
  const M = 48
  const RIGHT = 612 - M
  let y = 792 - M

  const line = (text: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number } = {}) => {
    const size = opts.size ?? 10
    if (y < M + 40) { page = doc.addPage([612, 792]); y = 792 - M }
    page.drawText(text, { x: opts.x ?? M, y, size, font: opts.font ?? font, color: opts.color ?? DARK })
    y -= size + 6
  }
  const right = (text: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {}, atY?: number) => {
    const size = opts.size ?? 10
    const f = opts.font ?? font
    const w = f.widthOfTextAtSize(text, size)
    page.drawText(text, { x: RIGHT - w, y: atY ?? y, size, font: f, color: opts.color ?? DARK })
  }
  const rule = () => { if (y < M + 40) { page = doc.addPage([612, 792]); y = 792 - M } page.drawLine({ start: { x: M, y: y + 2 }, end: { x: RIGHT, y: y + 2 }, thickness: 0.6, color: rgb(0.88, 0.88, 0.9) }); y -= 10 }

  // Header
  line('disco cater', { size: 18, font: bold, color: GRAD })
  line(`Order #${d.orderNumber}`, { size: 20, font: bold })
  y -= 2
  line(d.restaurantName, { size: 12, font: bold })
  if (d.restaurantAddress) line(d.restaurantAddress, { size: 9, color: GREY })
  if (d.restaurantPhone) line(d.restaurantPhone, { size: 9, color: GREY })
  y -= 4; rule()

  // Order meta
  line(`Service: ${d.orderService}`, { font: bold })
  if (d.orderDate) line(`Date: ${d.orderDate}`)
  if (d.orderTime) line(`Time: ${d.orderTime}`)
  if (d.persons) line(`Headcount: ${d.persons}`)
  if (d.orderReceived) line(`Received: ${d.orderReceived}`, { size: 9, color: GREY })
  y -= 4; rule()

  // Customer
  line('Customer', { size: 9, font: bold, color: GREY })
  line(d.customerName, { font: bold })
  if (d.companyName) line(d.companyName)
  if (d.customerEmail) line(d.customerEmail, { size: 9, color: GREY })
  if (d.customerPhone) line(d.customerPhone, { size: 9, color: GREY })
  if (d.deliveryAddress) { line('Delivery to:', { size: 9, font: bold, color: GREY }); line(d.deliveryAddress, { size: 9 }) }
  if (d.note) { y -= 2; line(`Note: ${d.note}`, { size: 9, font: bold }) }
  y -= 4; rule()

  // Items
  line('Items', { size: 9, font: bold, color: GREY })
  for (const it of d.items) {
    const label = `${it.quantity} x ${it.name}`
    if (y < M + 40) { page = doc.addPage([612, 792]); y = 792 - M }
    const rowY = y
    page.drawText(label, { x: M, y: rowY, size: 10, font, color: DARK })
    right(money(it.price * it.quantity), {}, rowY)
    y -= 16
    if (it.note) line(`   ${it.note}`, { size: 8, color: GREY })
  }
  y -= 2; rule()

  // Totals
  const totalRow = (label: string, val: number, opts: { bold?: boolean } = {}) => {
    if (y < M + 40) { page = doc.addPage([612, 792]); y = 792 - M }
    const f = opts.bold ? bold : font
    const rowY = y
    page.drawText(label, { x: M, y: rowY, size: opts.bold ? 12 : 10, font: f, color: DARK })
    right(money(val), { font: f, size: opts.bold ? 12 : 10 }, rowY)
    y -= (opts.bold ? 20 : 16)
  }
  totalRow('Subtotal', d.subtotal)
  if (d.serviceCharge) totalRow('Service charge', d.serviceCharge)
  if (d.deliveryFee) totalRow('Delivery', d.deliveryFee)
  if (d.taxes) totalRow('Taxes', d.taxes)
  if (d.fees) totalRow('Fees', d.fees)
  if (d.tip) totalRow('Tip', d.tip)
  if (d.promo) totalRow('Discount', -Math.abs(d.promo))
  if (d.refund) totalRow('Refund', -Math.abs(d.refund))
  y -= 2; rule()
  totalRow('Total', d.total, { bold: true })

  if (d.taxExemptId) { y -= 4; line(`Tax Exempt #: ${d.taxExemptId}`, { size: 9, font: bold }) }

  return doc.save()
}

// Convenience: load + render by reference. Returns null when the order isn't found.
export async function buildOrderPdfByReference(orderRef: string): Promise<Uint8Array | null> {
  const data = await loadOrderPdfData(orderRef)
  if (!data) return null
  return renderOrderPdf(data)
}
