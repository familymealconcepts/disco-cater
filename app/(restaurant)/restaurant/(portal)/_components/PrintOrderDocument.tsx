// Builds a complete, standalone HTML document for a single order that
// mirrors FamilyMeal's /public-api/order/{ref}/pdf layout.
//
// The previous approach was a hidden in-DOM div + @media print visibility
// trick; that failed because the drawer that owns the div is
// `position: fixed`, which makes nested `position: absolute` print-doc
// behavior unreliable across browsers (Safari + Chrome both produced
// blank pages for some users). The current path opens a fresh window
// and writes a full HTML document into it, then calls print() on that
// window. Side-steps the parent-page stylesheet cascade entirely.
//
// FM field mapping (confirmed against the deployed /api/orders/{ref}
// response shape, not the speculative FM contract):
//   orderNumber, total, orderDate, orderTime, createdDate
//   firstName, lastName, email, phoneNumber
//   restaurant.businessName, restaurant.address.{addressLine1,city,
//     state,zipcode,phoneNumber}, restaurant.deliveryOrderTimeWindows,
//     restaurant.feeCategories[0].displayFeeCategoriesName
//   deliveryAddress.{addressLine1,addressLine2,city,state,zipcode}
//   orderDropOffTime (ISO)
//   subtotal, fee, serviceCharge, discount, refund, employeeBenefit
//   stateSalesTaxInPrice + localSalesTaxInPrice + otherSalesTaxInPrice
//   ownDeliveryFee + doordashDeliveryFee + thirdPartyDeliveryFee
//   tipsInPrice + thirdPartyDeliveryTipsInPrice
//   orderMealPackages[].{name, count, price, comment,
//     orderAddOns: [{name, count, price}]}
//   orderClassics[].{name, count, price, comment}

interface OrderAddOn {
  name?: string
  count?: number
  price?: number
}

interface OrderLineItem {
  name?: string
  count?: number
  price?: number
  comment?: string
  orderAddOns?: OrderAddOn[]
}

export interface PrintableOrder {
  orderNumber?: number
  orderReference?: string
  orderDate?: string
  orderTime?: string
  orderDropOffTime?: string
  orderType?: string
  createdDate?: string
  persons?: number
  firstName?: string
  lastName?: string
  companyName?: string
  email?: string
  phoneNumber?: string
  restaurant?: {
    businessName?: string
    deliveryOrderTimeWindows?: string
    address?: {
      addressLine1?: string
      addressLine2?: string
      city?: string
      state?: string
      zipcode?: string
      phoneNumber?: string
    }
    feeCategories?: { displayFeeCategoriesName?: string }[]
  }
  deliveryAddress?: {
    addressLine1?: string
    addressLine2?: string
    city?: string
    state?: string
    zipcode?: string
    deliveryInstructions?: string
  }
  subtotal?: number
  total?: number
  serviceCharge?: number
  fee?: number
  discount?: number
  refund?: number
  employeeBenefit?: number
  stateSalesTaxInPrice?: number
  localSalesTaxInPrice?: number
  otherSalesTaxInPrice?: number
  ownDeliveryFee?: number
  doordashDeliveryFee?: number
  thirdPartyDeliveryFee?: number
  tipsInPrice?: number
  thirdPartyDeliveryTipsInPrice?: number
  orderMealPackages?: OrderLineItem[]
  orderClassics?: OrderLineItem[]
  note?: string
  taxExempt?: boolean
  taxExemptId?: string
  taxExemptState?: string
}

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtMoney(n?: number): string {
  return `$${(n || 0).toFixed(2)}`
}

// Robust order-date parser. FM hands back either YYYY-MM-DD or DD.MM.YYYY; both
// must produce a valid Date (the old `new Date(`${d}T12:00:00`)` returned Invalid
// Date for the dotted form). Returns null when unparseable.
function parseOrderDate(d?: string): Date | null {
  if (!d) return null
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d)
  if (dmy) return new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T12:00:00`)
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
  if (ymd) return new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T12:00:00`)
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? null : dt
}

function fmtShortDate(d?: string): string {
  const dt = parseOrderDate(d)
  if (!dt) return ''
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`
}

// "Day MM/DD/YYYY" (e.g. "Mon 06/30/2026").
function fmtLongDate(d?: string): string {
  const dt = parseOrderDate(d)
  if (!dt) return ''
  return `${dt.toLocaleDateString('en-US', { weekday: 'short' })} ${fmtShortDate(d)}`
}

function fmtTime12(t?: string): string {
  if (!t) return ''
  const parts = t.split(':')
  const h = parseInt(parts[0] || '0', 10)
  const m = parts[1] || '00'
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0').slice(0, 2)} ${ampm}`
}

function addMinutes(t: string | undefined, minutes: number): string {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  const h = parseInt(hStr || '0', 10)
  const m = parseInt(mStr || '0', 10)
  if (isNaN(h)) return ''
  const total = h * 60 + m + minutes
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60)
  const nh = Math.floor(wrapped / 60)
  const nm = wrapped % 60
  const ampm = nh >= 12 ? 'PM' : 'AM'
  const h12 = nh % 12 || 12
  return `${h12}:${String(nm).padStart(2, '0')} ${ampm}`
}

function fmtTimeRange(t: string | undefined, windowKey: string | undefined): string {
  const start = fmtTime12(t)
  if (!start) return ''
  if (windowKey === '30_min') return `${start} - ${addMinutes(t, 30)}`
  if (windowKey === '1_hour') return `${start} - ${addMinutes(t, 60)}`
  return start
}

// Guard against Invalid Date: an unparseable ISO string used to render the
// literal "Invalid Date" (a truthy string), which broke the `||` fallback to
// the order's own date/time. Now it returns '' so the fallback fires.
function fmtIsoTime(iso?: string): string {
  if (!iso) return ''
  const dt = new Date(iso)
  if (isNaN(dt.getTime())) return ''
  return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// "Day MM/DD/YYYY" from an ISO timestamp; '' when unparseable.
function fmtIsoLongDate(iso?: string): string {
  if (!iso) return ''
  const dt = new Date(iso)
  if (isNaN(dt.getTime())) return ''
  const mmddyyyy = `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`
  return `${dt.toLocaleDateString('en-US', { weekday: 'short' })} ${mmddyyyy}`
}

function fmtReceived(iso?: string): string {
  if (!iso) return ''
  try {
    const dt = new Date(iso)
    return dt.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
  } catch { return '' }
}

function joinAddressLines(a?: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zipcode?: string }): string[] {
  if (!a) return []
  const line1 = [a.addressLine1, a.addressLine2].filter(Boolean).join(', ')
  const cityStateZip = [
    [a.city, a.state].filter(Boolean).join(', '),
    a.zipcode,
  ].filter(Boolean).join(' ')
  return [line1, cityStateZip].filter(Boolean) as string[]
}

// HTML escaping — order content goes through user-controlled fields
// (restaurant address, customer name, note text, etc).
function esc(s: string | number | undefined | null): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Public: render a complete HTML document for the print window ────────────

export function buildPrintHtml(order: PrintableOrder): string {
  const customerName = [order.firstName, order.lastName].filter(Boolean).join(' ').trim()
  const total = order.total ?? 0
  const subtotal = order.subtotal ?? 0
  const tax = (order.stateSalesTaxInPrice ?? 0) + (order.localSalesTaxInPrice ?? 0) + (order.otherSalesTaxInPrice ?? 0)
  const delivery = (order.ownDeliveryFee ?? 0) + (order.doordashDeliveryFee ?? 0) + (order.thirdPartyDeliveryFee ?? 0)
  const tips = (order.tipsInPrice ?? 0) + (order.thirdPartyDeliveryTipsInPrice ?? 0)
  const fee = order.fee ?? 0
  const serviceCharge = order.serviceCharge ?? 0
  const discount = order.discount ?? 0
  const refund = order.refund ?? 0
  const employeeBenefit = order.employeeBenefit ?? 0
  // FM shows this line as "Service Charges" between Subtotal and Taxes.
  const serviceLabel = order.restaurant?.feeCategories?.[0]?.displayFeeCategoriesName || 'Service Charges'
  // FM may carry the surcharge under serviceCharge OR fee; prefer the dedicated
  // field, fall back to fee so the row isn't silently dropped.
  const serviceCharges = serviceCharge > 0 ? serviceCharge : fee

  const isDelivery = (order.orderType || '').toUpperCase() === 'DELIVERY'
  const timeRange = fmtTimeRange(order.orderTime, order.restaurant?.deliveryOrderTimeWindows)
  const storeAddrLines = joinAddressLines(order.restaurant?.address)
  const customerAddrLines = isDelivery ? joinAddressLines(order.deliveryAddress) : []

  const items: OrderLineItem[] = [
    ...(order.orderMealPackages || []),
    ...(order.orderClassics || []),
  ]

  // ─── Header line — matches FM PDF "FamilyMeal Order #N (...) date, range for customer" ───
  const headerBits = [
    `#${esc(order.orderNumber ?? '')}`,
    `(${fmtMoney(total)})`,
    order.orderDate ? esc(fmtShortDate(order.orderDate)) : '',
    timeRange ? `, ${esc(timeRange)}` : '',
    customerName ? ` for ${esc(customerName)}` : '',
  ].filter(Boolean).join(' ')

  const itemRows = items.map(it => {
    const lineTotal = (it.price ?? 0) * (it.count ?? 1)
    const main = `
      <tr>
        <td class="qty">${esc(it.count ?? 1)}</td>
        <td>${esc(it.name || '—')}</td>
        <td class="price">${esc(fmtMoney(lineTotal))}</td>
      </tr>
    `
    const addOns = (it.orderAddOns || []).map(a => {
      const addonTotal = (a.price ?? 0) * (a.count ?? 1)
      return `
        <tr>
          <td class="qty"></td>
          <td class="addon">+ (${esc(a.count ?? 1)}) ${esc(a.name || '')}</td>
          <td class="price">${esc(fmtMoney(addonTotal))}</td>
        </tr>
      `
    }).join('')
    const comment = it.comment ? `
      <tr>
        <td></td>
        <td class="comment">Special Instructions: ${esc(it.comment)}</td>
        <td></td>
      </tr>
    ` : ''
    return main + addOns + comment
  }).join('')

  // Totals — only show rows the order actually has, mirroring FM.
  function totalRow(label: string, value: number, opts?: { bold?: boolean; red?: boolean; green?: boolean }) {
    const cls = opts?.bold ? 'class="total-row"' : ''
    const color = opts?.red ? '#d32f2f' : opts?.green ? '#1D9E75' : ''
    const colorStyle = color ? ` style="color:${color};"` : ''
    return `<tr ${cls}><td class="tlbl"${colorStyle}>${esc(label)}:</td><td class="tval"${colorStyle}>${esc(fmtMoney(value))}</td></tr>`
  }
  // Tax-exempt orders: taxes are $0.00 and the exempt id is noted under the row.
  const isTaxExempt = order.taxExempt === true || !!order.taxExemptId
  const taxRows = isTaxExempt
    ? totalRow('Taxes', 0) + `<tr><td class="tlbl" colspan="2" style="font-weight:normal;color:#333;padding-top:0;">Tax Exempt ID: ${esc(order.taxExemptId || '—')}</td></tr>`
    : (tax > 0 ? totalRow('Taxes', tax) : '')
  const totalRowsHtml = [
    totalRow('Subtotal', subtotal),
    employeeBenefit > 0 ? totalRow('For The Staff', employeeBenefit) : '',
    serviceCharges > 0 ? totalRow(serviceLabel, serviceCharges) : '',
    taxRows,
    // Only a separate platform-fee line when fee isn't already the service charge.
    fee > 0 && serviceCharge > 0 ? totalRow('Platform Fee', fee) : '',
    delivery > 0 ? totalRow('Delivery Fee', delivery) : '',
    tips > 0 ? totalRow('Tip', tips) : '',
    discount > 0 ? totalRow('Discount', -discount, { green: true }) : '',
    // Refunded: Amount Charged → Refund (red) → Net Total (bold). Otherwise Total.
    refund > 0 ? totalRow('Amount Charged', total) : '',
    refund > 0 ? totalRow('Refund', -refund, { red: true }) : '',
    refund > 0
      ? totalRow('Net Total', total - refund, { bold: true })
      : totalRow('Total', total, { bold: true }),
  ].filter(Boolean).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <!-- Empty title so the browser print header doesn't show "Disco Cater Order N"
       or the about:blank URL. @page margin:0 suppresses the browser's own
       header/footer (date, URL, page numbers) entirely. -->
  <title> </title>
  <style>
    @page { size: letter portrait; margin: 0; }
    @media print {
      header, footer { display: none !important; }
      body { padding: 0.5in; }
    }
    * { box-sizing: border-box; }
    body {
      font-family: Arial, "Helvetica Neue", Helvetica, system-ui, sans-serif;
      font-size: 12px;
      color: #000;
      background: #fff;
      margin: 0;
      padding: 0;
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .header {
      border: 1px solid #000;
      padding: 8px 10px;
      margin-bottom: 10px;
    }
    .header .title {
      font-weight: 700;
      font-size: 13px;
    }
    .header .received {
      font-size: 11px;
      margin-top: 4px;
    }
    table.cols {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 10px;
      table-layout: fixed;
    }
    table.cols td {
      border: 1px solid #000;
      padding: 8px 10px;
      vertical-align: top;
      width: 50%;
    }
    table.cols td.head {
      font-weight: 700;
      font-size: 12px;
      background: #f0f0f0;
    }
    .line { margin: 1px 0; }
    .line .lbl { font-weight: 700; margin-right: 4px; }
    table.items {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 10px;
    }
    table.items th, table.items td {
      border: 1px solid #000;
      padding: 6px 8px;
      font-size: 12px;
    }
    table.items th {
      background: #f0f0f0;
      text-align: left;
      font-weight: 700;
    }
    table.items th.qty, table.items td.qty {
      width: 50px;
      text-align: center;
    }
    table.items th.price, table.items td.price {
      width: 90px;
      text-align: right;
    }
    table.items td.addon {
      padding-left: 18px;
      font-size: 11px;
    }
    table.items td.comment {
      padding-left: 18px;
      font-style: italic;
      font-size: 11px;
    }
    table.totals {
      width: 50%;
      margin-left: auto;
      border-collapse: collapse;
      margin-bottom: 14px;
    }
    table.totals td {
      padding: 3px 8px;
      font-size: 12px;
    }
    table.totals td.tlbl { text-align: right; }
    table.totals td.tval { text-align: right; width: 110px; }
    table.totals tr.total-row td {
      border-top: 1px solid #000;
      font-weight: 700;
      font-size: 13px;
      padding-top: 6px;
    }
    .notes {
      border: 1px solid #000;
      padding: 8px 10px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .notes .lbl { font-weight: 700; margin-right: 4px; }
    .footer {
      font-size: 10px;
      color: #888;
      margin-top: 20px;
      padding-top: 8px;
      border-top: 1px solid #ddd;
      text-align: center;
    }
    @media screen {
      body { padding: 24px; max-width: 720px; margin: 0 auto; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Disco Cater Order ${headerBits}</div>
    ${order.createdDate ? `<div class="received">Received on ${esc(fmtReceived(order.createdDate))}</div>` : ''}
  </div>

  <table class="cols" cellspacing="0" cellpadding="0">
    <tr>
      <td class="head">ORDER DETAILS</td>
      <td class="head">${isDelivery ? 'DELIVERY' : 'PICKUP TIME'}</td>
    </tr>
    <tr>
      <td>
        ${order.orderDate ? `<div class="line"><span class="lbl">Date:</span>${esc(fmtLongDate(order.orderDate))}</div>` : ''}
        ${timeRange ? `<div class="line"><span class="lbl">Time:</span>${esc(timeRange)}</div>` : ''}
        ${order.persons != null ? `<div class="line"><span class="lbl">Headcount:</span>${esc(String(order.persons))}</div>` : ''}
        ${isTaxExempt && order.taxExemptState ? `<div class="line"><span class="lbl">Tax Exempt State:</span>${esc(order.taxExemptState)}</div>` : ''}
        ${order.createdDate ? `<div class="line"><span class="lbl">Order Placed:</span>${esc(fmtReceived(order.createdDate))}</div>` : ''}
      </td>
      <td>
        <div class="line"><span class="lbl">Date:</span>${esc(fmtIsoLongDate(order.orderDropOffTime) || fmtLongDate(order.orderDate))}</div>
        <div class="line"><span class="lbl">Time:</span>${esc(fmtIsoTime(order.orderDropOffTime) || fmtTime12(order.orderTime))}</div>
      </td>
    </tr>
  </table>

  <table class="cols" cellspacing="0" cellpadding="0">
    <tr>
      <td class="head">STORE</td>
      <td class="head">CUSTOMER</td>
    </tr>
    <tr>
      <td>
        ${order.restaurant?.businessName ? `<div class="line"><strong>${esc(order.restaurant.businessName)}</strong></div>` : ''}
        ${storeAddrLines.map(l => `<div class="line">${esc(l)}</div>`).join('')}
        ${order.restaurant?.address?.phoneNumber ? `<div class="line">${esc(order.restaurant.address.phoneNumber)}</div>` : ''}
      </td>
      <td>
        ${customerName ? `<div class="line"><strong>${esc(customerName)}</strong></div>` : ''}
        ${order.companyName ? `<div class="line"><span class="lbl">Company:</span>${esc(order.companyName)}</div>` : ''}
        ${order.email ? `<div class="line">${esc(order.email)}</div>` : ''}
        ${order.phoneNumber ? `<div class="line">${esc(order.phoneNumber)}</div>` : ''}
        ${customerAddrLines.map(l => `<div class="line">${esc(l)}</div>`).join('')}
        ${order.deliveryAddress?.deliveryInstructions ? `<div class="line"><span class="lbl">Notes:</span>${esc(order.deliveryAddress.deliveryInstructions)}</div>` : ''}
      </td>
    </tr>
  </table>

  ${order.note ? `
  <div class="notes">
    <span class="lbl">Order Notes:</span> ${esc(order.note)}
  </div>
  ` : ''}

  ${items.length > 0 ? `
  <table class="items" cellspacing="0" cellpadding="0">
    <thead>
      <tr>
        <th class="qty">Qty</th>
        <th>Item</th>
        <th class="price">Price</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>
  ` : ''}

  <table class="totals" cellspacing="0" cellpadding="0">
    <tbody>${totalRowsHtml}</tbody>
  </table>

  <div class="footer">discocater.com</div>
</body>
</html>`
}

// Opens a fresh window, writes the print document into it, calls print(),
// and closes when the print dialog finishes. Returns false if the popup
// was blocked so the caller can surface an error to the user.
export function printOrder(order: PrintableOrder): boolean {
  if (typeof window === 'undefined') return false
  const html = buildPrintHtml(order)
  const w = window.open('', '_blank', 'width=820,height=900')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  // Wait one tick so the new doc paints fully before printing — some
  // browsers (Safari) otherwise print a blank first page.
  setTimeout(() => {
    try {
      w.focus()
      w.print()
    } catch {}
    // Close after the print dialog returns. Browsers vary on whether
    // print() blocks; wrap in a second timeout so we don't yank the
    // window out from under the user.
    setTimeout(() => { try { w.close() } catch {} }, 250)
  }, 150)
  return true
}
