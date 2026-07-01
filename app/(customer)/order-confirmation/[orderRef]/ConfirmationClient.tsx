'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../../components/GlobalHeader'
import { formatTimeWindow } from '../../../../lib/utils/deliveryTimeWindow'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const DARK = '#1A1028'
const FM_PUBLIC = process.env.NEXT_PUBLIC_FM_API_BASE_URL || 'https://api.familymeal.com'

function fmt$(n: number) { return `$${n.toFixed(2)}` }
function fmtDate(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) } catch { return d }
}

export default function ConfirmationClient({ orderRef }: { orderRef: string }) {
  const [order, setOrder] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // Disco promo for this order (Neon source of truth) — display only. The card
  // is charged the full FM total; the discount is refunded via Stripe post-order.
  const [promo, setPromo] = useState<{ code: string; discountApplied: number } | null>(null)

  // When loaded inside an iframe (e.g. the /account/orders "New order
  // from calendar" dialog), notify the parent so it can close the
  // drawer and refresh the calendar. Same-origin embed only.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.top && window.top !== window) {
      try {
        window.parent.postMessage(
          { type: 'disco:order-placed', orderRef },
          window.location.origin
        )
      } catch {}
    }
  }, [orderRef])

  useEffect(() => {
    fetch(`/api/order/status?orderRef=${orderRef}`)
      .then(async r => {
        const d = await r.json().catch(() => null)
        // Treat a failed request, an error payload, or an empty object as a
        // genuine load failure — don't render a fake "Order Confirmed!".
        if (!r.ok || !d || d.error || (typeof d === 'object' && Object.keys(d).length === 0)) {
          setError(true)
        } else {
          setOrder(d)
        }
        setLoading(false)
      })
      .catch(() => { setError(true); setLoading(false) })
  }, [orderRef])

  // Look up any Disco promo applied to this order (for the breakdown line).
  useEffect(() => {
    fetch(`/api/promo/order-promo?orderRef=${orderRef}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.code) setPromo({ code: d.code, discountApplied: Number(d.discountApplied) || 0 }) })
      .catch(() => {})
  }, [orderRef])

  const restaurantName = order?.restaurantName || order?.restaurant?.name || order?.restaurantReference || ''
  // Customer name + optional company (Disco-only, enriched onto /api/order/status).
  const customerName = `${order?.firstName || ''} ${order?.lastName || ''}`.trim()
  const companyName: string = order?.companyName || order?.company_name || ''
  // FM returns a short human-friendly order number on /api/userOrder/{ref}
  // (e.g. 82243405) — show that instead of the UUID. Fall back to the first
  // 8 chars of the UUID if FM doesn't return one (older orders, etc).
  const orderNumber = order?.orderNumber ?? order?.orderNum
  const displayId = orderNumber ? String(orderNumber) : orderRef.slice(0, 8)
  // /api/order/status returns a normalized `items` array ({ name, quantity,
  // price, lineTotal }); fall back to the raw FM shapes for older responses.
  const items: any[] = order?.items || order?.mealPackages || order?.orderMealPackages || order?.packages || []
  const total = order?.total ?? order?.totalAmount ?? order?.totalCost ?? 0
  const deliveryFee = order?.deliveryFee ?? 0
  const tips = order?.tips ?? 0
  const subtotal = order?.subtotal ?? order?.subTotal ?? 0
  // FM splits tax across three fields (checkoutPricesV2); platform fee is `fee`.
  const tax = (Number(order?.stateSalesTaxInPrice) || 0) + (Number(order?.localSalesTaxInPrice) || 0) + (Number(order?.otherSalesTaxInPrice) || 0)
  const platformFee = Number(order?.fee ?? order?.serviceFee ?? order?.platformFee) || 0
  // Actual refund recorded against this order (distinct from the Disco promo
  // credit below, which is a post-order card credit shown for transparency).
  const refund = Number(order?.refund) || 0
  const orderDate = order?.orderDate || order?.localDate || ''
  const orderTime = order?.orderTime || order?.localTime || ''
  const orderType = order?.orderType || ''
  // Delivery time-window snapshot (persisted at placement). Delivery orders with a
  // non-'exact' window show the time as a range; null/'exact'/pickup → exact time.
  const deliveryTimeWindow: string = order?.deliveryTimeWindow || order?.delivery_time_window || ''
  const orderTimeDisplay = orderTime ? formatTimeWindow(orderTime, deliveryTimeWindow, orderType === 'DELIVERY') : ''
  // Order note (e.g. "Include utensils"). Shown only when non-empty.
  const orderNote: string = order?.note || order?.orderNote || ''
  const addr = order?.deliveryAddress
  // Tax-exempt orders: FM (or the Neon fallback in /api/order/status) returns
  // taxExempt + taxExemptId. When present, taxes are $0.00 and we surface the id.
  const taxExemptId: string = order?.taxExemptId || order?.tax_exempt_id || ''
  const taxExemptState: string = order?.taxExemptState || order?.tax_exempt_state || ''
  const isTaxExempt = order?.taxExempt === true || !!taxExemptId

  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      <div style={{ maxWidth: 640, margin: '0 auto', padding: '48px 24px 80px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#888', fontSize: 15 }}>Loading your order…</div>
        ) : error ? (
          <div>
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#FEF2F2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 36 }}>⚠️</div>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: DARK, margin: '0 0 12px', letterSpacing: '-0.02em' }}>We couldn&apos;t load your order details</h1>
              <p style={{ fontSize: 15, color: '#666', margin: '0 auto 32px', maxWidth: 460, lineHeight: 1.6 }}>
                Your order may still have been placed. Check your email for a confirmation, or contact us at{' '}
                <a href="mailto:concierge@discocater.com" style={{ color: BLUE, fontWeight: 600, textDecoration: 'none' }}>concierge@discocater.com</a>{' '}
                with order reference: <strong style={{ color: DARK }}>{orderRef}</strong>
              </p>
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link href="/account/orders" style={{ padding: '13px 28px', background: BLUE, color: '#fff', borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none', boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }}>View My Orders</Link>
            </div>
          </div>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 40 }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#ECFDF5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 36 }}>✅</div>
              <h1 style={{ fontSize: 28, fontWeight: 800, color: DARK, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Order Confirmed!</h1>
              {restaurantName && <p style={{ fontSize: 16, color: '#666', margin: '0 0 6px' }}>Your catering from <strong>{restaurantName}</strong> is confirmed.</p>}
              <p style={{ fontSize: 13, color: '#aaa' }}>Order #{displayId}</p>
            </div>

            {/* Order details */}
            <div style={{ background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', overflow: 'hidden', marginBottom: 20 }}>
              {(customerName || companyName) && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Contact</div>
                  {customerName && <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{customerName}</div>}
                  {companyName && <div style={{ fontSize: 13, color: '#666', marginTop: 2 }}>{companyName}</div>}
                </div>
              )}
              {(orderDate || orderTime || orderType || addr) && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #f8f8f8' }}>
                  {orderDate && (
                    <div style={{ padding: '16px 20px', borderRight: '1px solid #f8f8f8' }}>
                      <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Date</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{fmtDate(orderDate)}</div>
                    </div>
                  )}
                  {orderTime && (
                    <div style={{ padding: '16px 20px' }}>
                      <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Time</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{orderTimeDisplay}</div>
                    </div>
                  )}
                </div>
              )}
              {orderType && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Fulfillment</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{orderType === 'PICKUP' ? '🏃 Pickup' : '🚚 Delivery'}</div>
                </div>
              )}
              {orderNote && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Notes</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK, whiteSpace: 'pre-wrap' }}>{orderNote}</div>
                </div>
              )}
              {(() => {
                // Headcount lives either in a dedicated orderHeadcount
                // field (forward-compat with FM) or in the order note as
                // "Headcount: N" — read both.
                const direct = (order?.orderHeadcount ?? order?.headcount ?? order?.persons) as number | undefined
                const noteText: string = order?.note || order?.comment || ''
                const m = noteText.match(/Headcount:\s*(\d+)/i)
                const n = direct ?? (m ? parseInt(m[1], 10) : null)
                if (!n || n <= 0) return null
                return (
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                    <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Headcount</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>👥 {n} {n === 1 ? 'person' : 'people'}</div>
                  </div>
                )
              })()}
              {addr && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Deliver to</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{addr.addressLine1}, {addr.city}, {addr.state} {addr.zipcode}</div>
                </div>
              )}

              {isTaxExempt && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Tax Exempt</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>Tax Exempt ID: {taxExemptId || '—'}</div>
                  {taxExemptState && <div style={{ fontSize: 14, fontWeight: 600, color: DARK, marginTop: 2 }}>Tax Exempt State: {taxExemptState}</div>}
                </div>
              )}

              {/* Items — itemized list: name, quantity, price per item, line total */}
              {items.length > 0 && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Items</div>
                  {items.map((item: any, i: number) => {
                    const name = item.name || item.mealPackageName || item.packageName || 'Item'
                    const quantity = Number(item.quantity ?? item.count) || 1
                    const price = Number(item.price ?? item.pricePerUnit) || 0
                    const lineTotal = Number(item.lineTotal) || price * quantity
                    return (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10, fontSize: 14, color: DARK }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{name}</div>
                          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                            {quantity} × {fmt$(price)} each
                          </div>
                        </div>
                        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt$(lineTotal)}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Totals */}
              <div style={{ padding: '16px 20px', background: '#fafafa' }}>
                {subtotal > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Subtotal</span><span>{fmt$(subtotal)}</span>
                  </div>
                )}
                {(tax > 0 || isTaxExempt) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Taxes{isTaxExempt && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: '#16A34A' }}>Tax Exempt</span>}</span>
                    <span>{fmt$(isTaxExempt ? 0 : tax)}</span>
                  </div>
                )}
                {platformFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Platform Fee</span><span>{fmt$(platformFee)}</span>
                  </div>
                )}
                {deliveryFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Delivery Fee</span><span>{fmt$(deliveryFee)}</span>
                  </div>
                )}
                {tips > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Tip</span><span>{fmt$(tips)}</span>
                  </div>
                )}
                {promo && promo.discountApplied > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, fontSize: 13, color: '#1D9E75', fontWeight: 600 }}>
                      <span>Discount ({promo.code})</span><span>−{fmt$(promo.discountApplied)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#999', marginBottom: 6 }}>Credited back to your card after the order.</div>
                  </>
                )}
                {/* Refunded orders (RULE 3): Amount Charged → Refund (red) → Net Total. */}
                {total > 0 && refund > 0 ? (
                  <div style={{ paddingTop: 10, marginTop: 6, borderTop: '1px solid #eee' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                      <span>Amount Charged</span><span>{fmt$(total)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#E53935', fontWeight: 600 }}>
                      <span>Refund</span><span>−{fmt$(refund)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, marginTop: 2, borderTop: '1px solid #eee', fontSize: 17, fontWeight: 800, color: DARK }}>
                      <span>Net Total</span><span>{fmt$(Math.max(0, total - refund))}</span>
                    </div>
                  </div>
                ) : total > 0 ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, marginTop: 6, borderTop: '1px solid #eee', fontSize: 17, fontWeight: 800, color: DARK }}>
                    <span>Total</span><span>{fmt$(total)}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Invoice download */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1.5px solid #f0f0f0', padding: '14px 20px', marginBottom: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 14, color: '#555', fontWeight: 500 }}>Order invoice</span>
              <a href={`${FM_PUBLIC}/public-api/order/${orderRef}/pdf`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 13, fontWeight: 700, color: BLUE, textDecoration: 'none' }}>
                Download PDF ↓
              </a>
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link href="/portal" style={{ padding: '13px 28px', background: BLUE, color: '#fff', borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none', boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }}>
                View My Orders
              </Link>
              <Link href="/fullmap" style={{ padding: '13px 28px', background: '#f0f0f0', color: DARK, borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
                Browse More
              </Link>
            </div>
          </>
        )}
      </div>

      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); *{box-sizing:border-box;}`}</style>
    </div>
  )
}
