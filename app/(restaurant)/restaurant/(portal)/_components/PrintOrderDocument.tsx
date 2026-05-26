'use client'

// Print-only document that mirrors FM's /public-api/order/{ref}/pdf
// output. Rendered hidden on screen; @media print rules in the parent
// drawer hide everything except .print-doc and let the browser send
// just this layout to the printer.
//
// Field mapping confirmed against FM source (shared/order-details
// template + order-history-details.mappingOrderDetails):
//   orderNumber, total, orderDate, orderTime, createdDate
//   firstName, lastName, email, phoneNumber
//   restaurant.businessName, restaurant.address.{addressLine1,city,
//     state,zipcode,phoneNumber}, restaurant.deliveryOrderTimeWindows,
//     restaurant.feeCategories[0].displayFeeCategoriesName
//   deliveryAddress.{addressLine1,addressLine2,city,state,zipcode}
//   orderDropOffTime (ISO)
//   subtotal, fee, serviceCharge, discount
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
  firstName?: string
  lastName?: string
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
}

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtMoney(n?: number): string {
  return `$${(n || 0).toFixed(2)}`
}

function fmtShortDate(d?: string): string {
  if (!d) return ''
  // FM sends YYYY-MM-DD — parse at noon local to dodge TZ rollback.
  try {
    const dt = new Date(`${d}T12:00:00`)
    return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`
  } catch { return d }
}

function fmtLongDate(d?: string): string {
  if (!d) return ''
  try {
    const dt = new Date(`${d}T12:00:00`)
    return dt.toLocaleDateString('en-US', { weekday: 'long' }) + ' ' + fmtShortDate(d)
  } catch { return d }
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

// Adds N minutes to an HH:mm[:ss] string, returns formatted 12-hour.
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

// Mirrors FM's timeRangeFormat pipe — show a range when the restaurant
// has a configured delivery window, single time otherwise.
function fmtTimeRange(t: string | undefined, windowKey: string | undefined): string {
  const start = fmtTime12(t)
  if (!start) return ''
  if (windowKey === '30_min') return `${start} - ${addMinutes(t, 30)}`
  if (windowKey === '1_hour') return `${start} - ${addMinutes(t, 60)}`
  return start
}

function fmtIsoTime(iso?: string): string {
  if (!iso) return ''
  try {
    const dt = new Date(iso)
    return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  } catch { return '' }
}

function fmtIsoDateShort(iso?: string): string {
  if (!iso) return ''
  try {
    const dt = new Date(iso)
    return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`
  } catch { return '' }
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

function joinAddress(a?: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zipcode?: string }): string {
  if (!a) return ''
  const line1 = [a.addressLine1, a.addressLine2].filter(Boolean).join(', ')
  const cityState = [a.city, a.state].filter(Boolean).join(', ')
  return [line1, cityState, a.zipcode].filter(Boolean).join(' · ').replace(/ · ([A-Z]{2})/g, ', $1')
}

// ── Component ───────────────────────────────────────────────────────────────

export default function PrintOrderDocument({ order }: { order: PrintableOrder }) {
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

  const serviceLabel = order.restaurant?.feeCategories?.[0]?.displayFeeCategoriesName || 'Service Charge'

  const isDelivery = (order.orderType || '').toUpperCase() === 'DELIVERY'
  const timeRange = fmtTimeRange(order.orderTime, order.restaurant?.deliveryOrderTimeWindows)

  const items: OrderLineItem[] = [
    ...(order.orderMealPackages || []),
    ...(order.orderClassics || []),
  ]

  return (
    <div className="print-doc">
      {/* All styling kept inline so external CSS reloads / dev hot
          reloads can't break the print layout mid-print. */}

      {/* Header */}
      <div className="pd-header">
        <div className="pd-title">
          Disco Cater Order #{order.orderNumber ?? '—'}
          {' '}({fmtMoney(total)})
          {order.orderDate && <> {fmtShortDate(order.orderDate)}</>}
          {timeRange && <>, {timeRange}</>}
          {customerName && <> for {customerName}</>}
        </div>
        {order.createdDate && (
          <div className="pd-subtitle">Received on {fmtReceived(order.createdDate)}</div>
        )}
      </div>

      {/* Two-column details */}
      <table className="pd-cols" cellSpacing={0} cellPadding={0}>
        <tbody>
          <tr>
            <td className="pd-col-head">ORDER DETAILS</td>
            <td className="pd-col-head">{isDelivery ? 'DELIVERY' : 'PICK-UP TIME'}</td>
          </tr>
          <tr>
            <td className="pd-col-body">
              <DetailLine label="Date" value={fmtLongDate(order.orderDate)} />
              <DetailLine label="Time" value={timeRange} />
              {order.restaurant?.businessName && (
                <DetailLine label="Store" value={order.restaurant.businessName} />
              )}
              {order.restaurant?.address && (
                <DetailLine value={joinAddress(order.restaurant.address)} />
              )}
              {order.restaurant?.address?.phoneNumber && (
                <DetailLine value={order.restaurant.address.phoneNumber} />
              )}
            </td>
            <td className="pd-col-body">
              {/* Right side — delivery / pickup time + customer */}
              <DetailLine label="Date" value={fmtIsoDateShort(order.orderDropOffTime) || fmtShortDate(order.orderDate)} />
              <DetailLine label="Time" value={fmtIsoTime(order.orderDropOffTime) || fmtTime12(order.orderTime)} />
              {customerName && <DetailLine label="Customer" value={customerName} />}
              {isDelivery && order.deliveryAddress && (
                <DetailLine value={joinAddress(order.deliveryAddress)} />
              )}
              {order.email && <DetailLine value={order.email} />}
              {order.phoneNumber && <DetailLine value={order.phoneNumber} />}
              {order.deliveryAddress?.deliveryInstructions && (
                <DetailLine label="Notes" value={order.deliveryAddress.deliveryInstructions} />
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Items */}
      {items.length > 0 && (
        <table className="pd-items" cellSpacing={0} cellPadding={0}>
          <thead>
            <tr>
              <th className="pd-col-qty">Qty</th>
              <th className="pd-col-item">Item</th>
              <th className="pd-col-price">Price</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const lineTotal = (it.price ?? 0) * (it.count ?? 1)
              return (
                <PrintItemRow key={i} item={it} lineTotal={lineTotal} />
              )
            })}
          </tbody>
        </table>
      )}

      {/* Totals — right aligned */}
      <table className="pd-totals" cellSpacing={0} cellPadding={0}>
        <tbody>
          <TotalRow label="Subtotal" value={subtotal} />
          {serviceCharge > 0 && <TotalRow label={serviceLabel} value={serviceCharge} />}
          {tax > 0 && <TotalRow label="Taxes" value={tax} />}
          {fee > 0 && <TotalRow label="Fees" value={fee} />}
          {delivery > 0 && <TotalRow label="Delivery Fee" value={delivery} />}
          {tips > 0 && <TotalRow label="Tips" value={tips} />}
          {discount > 0 && <TotalRow label="Promo" value={-discount} />}
          {refund > 0 && <TotalRow label="Refund" value={-refund} />}
          <TotalRow label="Total" value={total} bold />
        </tbody>
      </table>

      {/* Footer */}
      <div className="pd-footer">discocater.com</div>

      <style>{`
        /* Hidden on screen — only visible during print. The parent drawer
           also injects an @media print rule that hides everything outside
           .print-doc. */
        .print-doc { display: none; }

        @media print {
          @page { margin: 0.5in; size: auto; }
          html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
          .print-doc {
            display: block !important;
            font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
            font-size: 11px;
            color: #000;
            background: #fff;
            line-height: 1.45;
          }
          .pd-header { margin-bottom: 12px; }
          .pd-title { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
          .pd-subtitle { font-size: 10px; color: #000; }
          .pd-cols { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
          .pd-cols td { border: 1px solid #000; padding: 8px 10px; vertical-align: top; width: 50%; }
          .pd-col-head { font-weight: 700; font-size: 11px; background: #f0f0f0; }
          .pd-col-body { font-size: 11px; }
          .pd-line { margin: 1px 0; }
          .pd-line-label { font-weight: 700; margin-right: 4px; }
          .pd-items { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
          .pd-items th, .pd-items td { border: 1px solid #000; padding: 6px 8px; font-size: 11px; }
          .pd-items th { background: #f0f0f0; text-align: left; font-weight: 700; }
          .pd-col-qty { width: 8%; text-align: center !important; }
          .pd-col-item { width: 70%; }
          .pd-col-price { width: 22%; text-align: right !important; }
          .pd-items td.pd-price-cell { text-align: right; }
          .pd-items td.pd-qty-cell { text-align: center; }
          .pd-addon { padding-left: 18px; font-size: 10.5px; }
          .pd-comment { padding-left: 18px; font-style: italic; font-size: 10px; }
          .pd-totals { width: 50%; margin-left: auto; border-collapse: collapse; margin-bottom: 16px; }
          .pd-totals td { padding: 3px 8px; font-size: 11px; }
          .pd-totals td.pd-total-label { text-align: right; color: #000; }
          .pd-totals td.pd-total-value { text-align: right; width: 100px; }
          .pd-totals tr.pd-total-row td { border-top: 1px solid #000; font-weight: 700; font-size: 12px; padding-top: 6px; }
          .pd-footer { font-size: 9px; color: #000; margin-top: 12px; }
        }
      `}</style>
    </div>
  )
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function DetailLine({ label, value }: { label?: string; value?: string }) {
  if (!value) return null
  return (
    <div className="pd-line">
      {label && <span className="pd-line-label">{label}:</span>}
      <span>{value}</span>
    </div>
  )
}

function PrintItemRow({ item, lineTotal }: { item: OrderLineItem; lineTotal: number }) {
  return (
    <>
      <tr>
        <td className="pd-qty-cell">{item.count ?? 1}</td>
        <td>{item.name || '—'}</td>
        <td className="pd-price-cell">{fmtMoney(lineTotal)}</td>
      </tr>
      {item.orderAddOns?.map((a, j) => {
        const addonTotal = (a.price ?? 0) * (a.count ?? 1)
        return (
          <tr key={`a-${j}`}>
            <td className="pd-qty-cell"></td>
            <td className="pd-addon">+ ({a.count ?? 1}) {a.name || ''}</td>
            <td className="pd-price-cell">{fmtMoney(addonTotal)}</td>
          </tr>
        )
      })}
      {item.comment && (
        <tr>
          <td></td>
          <td className="pd-comment">Special Instructions: {item.comment}</td>
          <td></td>
        </tr>
      )}
    </>
  )
}

function TotalRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <tr className={bold ? 'pd-total-row' : undefined}>
      <td className="pd-total-label">{label}:</td>
      <td className="pd-total-value">{fmtMoney(value)}</td>
    </tr>
  )
}
