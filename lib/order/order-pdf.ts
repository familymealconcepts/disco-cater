// Server-side order PDF (pure-JS via pdf-lib — no native deps, serverless-safe).
// Used for: the PDF attached to restaurant confirmation + order-change emails,
// and the downloadable link in the restaurant SMS. Loads a normalized order by
// its Disco reference from Neon (mirrors the fields the email/notifications use).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { sql } from '../db'
import { fulfillmentDateTime } from './fulfillment-time'
import { DISCO_LOGO_PNG_BASE64, DISCO_LOGO_W, DISCO_LOGO_H } from './disco-logo'

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}
function money(n: number): string { return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}` }
function toIsoDate(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10)
}
function fmtDate(v: unknown): string {
  const iso = toIsoDate(v)
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y) return iso
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
}
// Plain "h:mm a" from a raw "HH:MM" / "HH:MM:SS" string — no window-ranging.
// The pick-up/fulfillment time is a single kitchen-readiness instant, not a
// customer-facing arrival window (formatTimeWindow's "start - end" range is a
// different concept and doesn't belong on this box — see fulfillment-time.ts).
function fmtTime(t: string): string {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
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
  // Fulfillment/pick-up date+time — same as orderDate/orderTime EXCEPT for a
  // self-delivery (OWN_DELIVERY) order, which is order time minus 30 minutes
  // (FM's convention). This is what the "{SERVICE} TIME" box shows; orderDate/
  // orderTime (the customer's actual selection) stay untouched for the subject
  // line and ORDER DETAILS block.
  pickupDate: string
  pickupTime: string
  orderReceived: string
  deliveryAddress?: string
  persons?: number
  note?: string
  deliveryInstructions?: string
  taxExemptId?: string
  items: { name: string; quantity: number; price: number; note?: string; addOns?: { name: string; price: number; quantity: number }[] }[]
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
    SELECT id, reference, order_number, order_type, delivery_type, order_date, order_time, delivery_time_window, note, delivery_instructions, created_at,
           customer_email, customer_first_name, customer_last_name, customer_phone,
           delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
           restaurant_reference, restaurant_name, restaurant_address, restaurant_phone, tax_exempt_id, tips,
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
    SELECT id, name, quantity, price_per_unit, notes FROM disco_order_items WHERE order_id = ${orderId} ORDER BY id
  `) as Record<string, unknown>[]

  // Per-item add-ons (itemized, name/price/qty) — shown as indented "+" sub-lines.
  const itemIds = items.map((it) => Number(it.id)).filter((n) => Number.isFinite(n))
  const addonRows = itemIds.length
    ? (await sql`
        SELECT order_item_id, name, price, quantity FROM disco_order_item_addons
        WHERE order_item_id = ANY(${itemIds}) ORDER BY id
      `.catch(() => [])) as Record<string, unknown>[]
    : []
  const addOnsByItem = new Map<number, { name: string; price: number; quantity: number }[]>()
  for (const a of addonRows) {
    const k = Number(a.order_item_id)
    const l = addOnsByItem.get(k) ?? []
    l.push({ name: String(a.name ?? ''), price: num(a.price), quantity: num(a.quantity) || 1 })
    addOnsByItem.set(k, l)
  }

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
    // Snapshot-first (frozen at order time → survives a deleted/renamed restaurant),
    // then the live cache — matching the fm-order-detail buildNeonDetail resolution.
    restaurantName: (o.restaurant_name ? String(o.restaurant_name) : '') || cacheName || 'Restaurant',
    restaurantPhone: (o.restaurant_phone ? String(o.restaurant_phone) : '') || cachePhone || undefined,
    restaurantAddress: (o.restaurant_address ? String(o.restaurant_address) : '') || cacheAddress || undefined,
    customerName: [o.customer_first_name, o.customer_last_name].filter(Boolean).join(' ') || '—',
    customerEmail: o.customer_email ? String(o.customer_email) : undefined,
    customerPhone: o.customer_phone ? String(o.customer_phone) : undefined,
    companyName: o.company_name ? String(o.company_name) : undefined,
    orderService: String(o.order_type ?? ''),
    orderDate: fmtDate(o.order_date),
    orderTime: fmtTime(String(o.order_time ?? '')),
    ...(() => {
      const rawOrderDate = toIsoDate(o.order_date)
      const rawOrderTime = String(o.order_time ?? '')
      const ft = fulfillmentDateTime(o.delivery_type as string | null, rawOrderDate, rawOrderTime)
      return { pickupDate: fmtDate(ft?.date ?? rawOrderDate), pickupTime: fmtTime(ft?.time ?? rawOrderTime) }
    })(),
    // "Received on …" in the restaurant's local timezone (was UTC, which read
    // ~4h ahead for an EDT restaurant). Falls back to America/New_York.
    orderReceived: o.created_at ? new Date(o.created_at as string).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: cacheTimezone || 'America/New_York' }) : '',
    deliveryAddress,
    persons: o.persons != null && Number(o.persons) > 0 ? Number(o.persons) : undefined,
    note: o.note ? String(o.note) : undefined,
    deliveryInstructions: o.delivery_instructions ? String(o.delivery_instructions) : undefined,
    taxExemptId: o.tax_exempt_id ? String(o.tax_exempt_id) : undefined,
    items: items.map((it) => ({ name: String(it.name ?? ''), quantity: num(it.quantity) || 1, price: num(it.price_per_unit), note: it.notes ? String(it.notes) : undefined, addOns: addOnsByItem.get(Number(it.id)) })),
    subtotal, serviceCharge, taxes, fees, deliveryFee, tip, promo, refund, total,
  }
}

const GRAD = rgb(0.42, 0.43, 0.98)   // disco wordmark indigo #6B6EF9
const CATER = rgb(0.60, 0.60, 0.66)  // "cater" grey
const DARK = rgb(0.10, 0.06, 0.16)   // #1A1028
const GREY = rgb(0.35, 0.35, 0.40)
const BORDER = rgb(0, 0, 0)
const FILL = rgb(0.95, 0.95, 0.965)

// Render the order as a bordered-grid invoice closely matching FamilyMeal's original
// order PDF (subject box, "Received on", ORDER DETAILS | {SERVICE} TIME, side-by-side
// Store/Customer boxes, bordered items table, totals with Taxes/Delivery/Tips), with
// Disco Cater's wordmark in place of FM's branding. (Itemized add-ons + true delivery
// instructions are a deferred follow-up — that data isn't captured yet.)
export async function renderOrderPdf(d: OrderPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const W = 612, H = 792, M = 46
  const LEFT = M, RIGHT = W - M, CW = RIGHT - LEFT
  let page = doc.addPage([W, H])
  let y = H - M

  const PADX = 7, PADY = 6, LH = 4
  const brk = (need: number) => { if (y - need < M) { page = doc.addPage([W, H]); y = H - M } }
  const text = (t: string, x: number, atY: number, size: number, f: PDFFont = font, color = DARK) => page.drawText(t, { x, y: atY, size, font: f, color })
  const textR = (t: string, xr: number, atY: number, size: number, f: PDFFont = font, color = DARK) => page.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y: atY, size, font: f, color })
  const trunc = (t: string, f: PDFFont, size: number, maxW: number) => {
    if (maxW <= 0 || f.widthOfTextAtSize(t, size) <= maxW) return t
    let s = t; while (s.length > 1 && f.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1); return s + '…'
  }
  type Ln = { t: string; b?: boolean; s?: number; c?: ReturnType<typeof rgb>; label?: boolean }
  const boxH = (lines: Ln[]) => Math.max(PADY * 2 + lines.reduce((a, l) => a + (l.s ?? 10) + LH, 0) - LH, 20)
  const cell = (x: number, top: number, w: number, lines: Ln[], h: number, fill?: ReturnType<typeof rgb>) => {
    page.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: BORDER, borderWidth: 1.2, ...(fill ? { color: fill } : {}) })
    let ty = top - PADY - (lines[0]?.s ?? 10)
    for (const l of lines) { const s = l.s ?? 10, f = (l.b || l.label) ? bold : font; text(trunc(l.t, f, s, w - PADX * 2), x + PADX, ty, s, f, l.c ?? DARK); ty -= s + LH }
  }
  const fullBox = (lines: Ln[], fill?: ReturnType<typeof rgb>) => { const h = boxH(lines); brk(h); cell(LEFT, y, CW, lines, h, fill); y -= h }
  const splitBox = (l: Ln[], r: Ln[], leftFrac = 0.5) => { const h = Math.max(boxH(l), boxH(r)); brk(h); const lw = CW * leftFrac; cell(LEFT, y, lw, l, h); cell(LEFT + lw, y, CW - lw, r, h); y -= h }

  // ── Disco Cater logo — the SAME asset used in the transactional-email header
  //    (public/disco-cater-logo-white-bg.png), embedded as an image. Falls back to
  //    the brand text wordmark if the PNG ever fails to embed. ──
  try {
    const logo = await doc.embedPng(Buffer.from(DISCO_LOGO_PNG_BASE64, 'base64'))
    const lw = 150, lh = lw * (DISCO_LOGO_H / DISCO_LOGO_W)
    page.drawImage(logo, { x: LEFT, y: y - lh, width: lw, height: lh })
    y -= lh + 10
  } catch {
    text('disco', LEFT, y - 16, 20, bold, GRAD)
    text(' cater', LEFT + bold.widthOfTextAtSize('disco', 20), y - 16, 20, bold, CATER)
    y -= 32
  }

  // ── Subject box + "Received on" ──
  const custName = (d.customerName && d.customerName !== '—') ? d.customerName : ''
  const subject = `Disco Cater Order ${d.orderNumber} (${money(d.total)})${d.orderDate ? ` ${d.orderDate}` : ''}${d.orderTime ? `, ${d.orderTime}` : ''}${custName ? ` for ${custName}` : ''}`
  fullBox([{ t: subject, b: true, s: 12 }])
  if (d.orderReceived) fullBox([{ t: `Received on ${d.orderReceived}`, s: 9.5, c: GREY }])

  // ── ORDER DETAILS: | {SERVICE} TIME: ──
  const isDelivery = (d.orderService || '').toUpperCase() === 'DELIVERY'
  const timeLabel = isDelivery ? 'DELIVERY PICK-UP TIME:' : `${(d.orderService || 'PICKUP').toUpperCase()} TIME:`
  // ORDER DETAILS shows the same date/time as the adjacent {SERVICE} TIME box
  // (previously just the raw service string, e.g. "DELIVERY", with no date/time
  // at all) — both already computed above, just not included here before.
  const leftDetail: Ln[] = [{ t: 'ORDER DETAILS:', label: true, s: 9.5 }, { t: d.orderService || 'Pickup', s: 11 }]
  if (d.pickupDate) leftDetail.push({ t: `Date: ${d.pickupDate}`, s: 10, c: GREY })
  if (d.pickupTime) leftDetail.push({ t: `Time: ${d.pickupTime}`, s: 10, c: GREY })
  if (d.persons) leftDetail.push({ t: `Headcount: ${d.persons}`, s: 10, c: GREY })
  const rightTime: Ln[] = [{ t: timeLabel, label: true, s: 9.5 }]
  if (d.pickupDate) rightTime.push({ t: `Date: ${d.pickupDate}`, s: 11 })
  if (d.pickupTime) rightTime.push({ t: `Time: ${d.pickupTime}`, s: 11 })
  // 0.5 split so the right column ({SERVICE} TIME) lines up exactly with the
  // Customer box below it — matching the Store column on the left at 0.5.
  splitBox(leftDetail, rightTime, 0.5)

  // ── Store: | Customer: ──
  const storeLines: Ln[] = [{ t: 'Store:', label: true, s: 9.5 }, { t: d.restaurantName || 'Restaurant', b: true, s: 11 }]
  if (d.restaurantAddress) storeLines.push({ t: d.restaurantAddress, s: 9.5, c: GREY })
  if (d.restaurantPhone) storeLines.push({ t: d.restaurantPhone, s: 9.5, c: GREY })
  const custLines: Ln[] = [{ t: 'Customer:', label: true, s: 9.5 }, { t: d.customerName || '—', b: true, s: 11 }]
  if (d.companyName) custLines.push({ t: d.companyName, s: 9.5, c: GREY })
  if (d.deliveryAddress) custLines.push({ t: d.deliveryAddress, s: 9.5, c: GREY })
  if (d.customerEmail) custLines.push({ t: d.customerEmail, s: 9.5, c: GREY })
  if (d.customerPhone) custLines.push({ t: d.customerPhone, s: 9.5, c: GREY })
  splitBox(storeLines, custLines, 0.5)

  // ── Note (general order note) ──
  if (d.note) fullBox([{ t: 'Note:', label: true, s: 9.5 }, { t: d.note, s: 10 }])
  // ── Delivery Instructions (distinct from the general note) ──
  if (d.deliveryInstructions) fullBox([{ t: 'Delivery Instructions:', label: true, s: 9.5 }, { t: d.deliveryInstructions, s: 10 }])

  // ── Items table (bordered rows) ──
  const IROW = 20, itemMaxW = CW - 92
  brk(IROW)
  page.drawRectangle({ x: LEFT, y: y - IROW, width: CW, height: IROW, borderColor: BORDER, borderWidth: 1.2, color: FILL })
  text('ITEM', LEFT + PADX, y - 14, 9, bold, DARK)
  textR('PRICE', RIGHT - PADX, y - 14, 9, bold, DARK)
  y -= IROW
  const SUBROW = 16
  for (const it of d.items) {
    const addOns = it.addOns ?? []
    const subLineCount = addOns.length + (it.note ? 1 : 0)
    const h = IROW + subLineCount * SUBROW
    brk(h)
    page.drawRectangle({ x: LEFT, y: y - h, width: CW, height: h, borderColor: BORDER, borderWidth: 1.2 })
    text(trunc(`(${it.quantity}) ${it.name}`, font, 10.5, itemMaxW), LEFT + PADX, y - 14, 10.5, font, DARK)
    // Item line total is the BASE price × qty; add-ons are their own priced sub-lines
    // (add-ons are stored separately, never baked into price_per_unit).
    textR(money(it.price * it.quantity), RIGHT - PADX, y - 14, 10.5, font, DARK)
    const bx = LEFT + PADX + 18
    let subY = y - 28
    // Add-ons: indented "+ {name}" with the add-on price on the right (FM style).
    for (const a of addOns) {
      const label = `${a.quantity > 1 ? `${a.quantity}× ` : ''}${a.name}`
      text('+', LEFT + PADX + 8, subY, 9, font, GREY)
      text(trunc(label, font, 9, RIGHT - PADX - bx - 44), bx, subY, 9, font, GREY)
      if (a.price) textR(money(a.price * a.quantity), RIGHT - PADX, subY, 9, font, GREY)
      subY -= SUBROW
    }
    // Item note: indented with a dash marker so it reads as a sub-line, not an item.
    if (it.note) {
      text('–', LEFT + PADX + 8, subY, 9, font, GREY)
      text(trunc(it.note, font, 9, RIGHT - PADX - bx), bx, subY, 9, font, GREY)
      subY -= SUBROW
    }
    y -= h
  }

  // ── Totals (right half) — Subtotal, Taxes, Fees, Delivery Fee, Tips, Total ──
  const totals: Array<[string, number, boolean?]> = [['Subtotal', d.subtotal]]
  if (d.serviceCharge) totals.push(['Service charge', d.serviceCharge])
  if (d.taxes) totals.push(['Taxes', d.taxes])
  if (d.fees) totals.push(['Fees', d.fees])
  if (d.deliveryFee) totals.push(['Delivery Fee', d.deliveryFee])
  if (d.tip) totals.push(['Tips', d.tip])
  if (d.promo) totals.push(['Discount', -Math.abs(d.promo)])
  if (d.refund) totals.push(['Refund', -Math.abs(d.refund)])
  totals.push(['Total', d.total, true])
  const tX = LEFT + CW * 0.5, tW = CW * 0.5, TROW = 19
  for (const [label, val, strong] of totals) {
    brk(TROW)
    page.drawRectangle({ x: tX, y: y - TROW, width: tW, height: TROW, borderColor: BORDER, borderWidth: 1.2, ...(strong ? { color: FILL } : {}) })
    const f = strong ? bold : font, s = strong ? 11.5 : 10.5
    text(label, tX + PADX, y - 13, s, f, DARK)
    textR(money(val), RIGHT - PADX, y - 13, s, f, DARK)
    y -= TROW
  }

  if (d.taxExemptId) { brk(18); text(`Tax Exempt #: ${d.taxExemptId}`, LEFT, y - 12, 10, bold, DARK); y -= 18 }

  return doc.save()
}

// Convenience: load + render by reference. Returns null when the order isn't found.
export async function buildOrderPdfByReference(orderRef: string): Promise<Uint8Array | null> {
  const data = await loadOrderPdfData(orderRef)
  if (!data) return null
  return renderOrderPdf(data)
}
