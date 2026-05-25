'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const DARK = '#1A1028'

function fmt$(n: number) { return `$${n.toFixed(2)}` }
function fmtDate(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) } catch { return d }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const dt = new Date(); dt.setHours(h, m); return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return t }
}

export default function ConfirmationClient({ orderRef }: { orderRef: string }) {
  const [order, setOrder] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/order/status?orderRef=${orderRef}`)
      .then(r => r.json())
      .then(d => { setOrder(d); setLoading(false) })
      .catch(() => { setError('Could not load order details.'); setLoading(false) })
  }, [orderRef])

  const restaurantName = order?.restaurantName || order?.restaurant?.name || order?.restaurantReference || ''
  const items: any[] = order?.mealPackages || order?.items || order?.packages || []
  const total = order?.total ?? order?.totalAmount ?? order?.totalCost ?? 0
  const deliveryFee = order?.deliveryFee ?? 0
  const tips = order?.tips ?? 0
  const subtotal = order?.subtotal ?? order?.subTotal ?? 0
  const orderDate = order?.orderDate || order?.localDate || ''
  const orderTime = order?.orderTime || order?.localTime || ''
  const orderType = order?.orderType || ''
  const addr = order?.deliveryAddress
  const status = order?.status || order?.orderStatus || ''

  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      <div style={{ maxWidth: 640, margin: '0 auto', padding: '48px 24px 80px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#888', fontSize: 15 }}>Loading your order…</div>
        ) : error ? (
          <div>
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
              <h1 style={{ fontSize: 28, fontWeight: 800, color: DARK, margin: '0 0 10px' }}>Order Placed!</h1>
              <p style={{ fontSize: 15, color: '#666', margin: '0 0 6px' }}>Your order has been confirmed.</p>
              <p style={{ fontSize: 13, color: '#aaa', margin: '0 0 32px' }}>Order #{orderRef}</p>
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <Link href="/portal" style={{ padding: '12px 24px', background: BLUE, color: '#fff', borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>My Orders</Link>
              <Link href="/fullmap" style={{ padding: '12px 24px', background: '#f0f0f0', color: DARK, borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>Browse More</Link>
            </div>
          </div>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 40 }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#ECFDF5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 36 }}>✅</div>
              <h1 style={{ fontSize: 28, fontWeight: 800, color: DARK, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Order Confirmed!</h1>
              {restaurantName && <p style={{ fontSize: 16, color: '#666', margin: '0 0 6px' }}>Your catering from <strong>{restaurantName}</strong> is confirmed.</p>}
              <p style={{ fontSize: 13, color: '#aaa' }}>Order #{orderRef}</p>
              {status && <span style={{ display: 'inline-block', marginTop: 8, padding: '4px 12px', borderRadius: 20, background: '#ECFDF5', color: '#166534', fontSize: 12, fontWeight: 700 }}>{status}</span>}
            </div>

            {/* Order details */}
            <div style={{ background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', overflow: 'hidden', marginBottom: 20 }}>
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
                      <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{fmtTime(orderTime)}</div>
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
              {addr && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Deliver to</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{addr.addressLine1}, {addr.city}, {addr.state} {addr.zipcode}</div>
                </div>
              )}

              {/* Items */}
              {items.length > 0 && (
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f8f8f8' }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Items</div>
                  {items.map((item: any, i: number) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 14, color: DARK }}>
                      <span>{item.quantity > 1 && <span style={{ color: '#888' }}>{item.quantity}× </span>}{item.name || item.mealPackageName || item.packageName}</span>
                      {item.price && <span style={{ fontWeight: 600 }}>{fmt$(item.price * (item.quantity || 1))}</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Totals */}
              <div style={{ padding: '16px 20px', background: '#fafafa' }}>
                {subtotal > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Subtotal</span><span>{fmt$(subtotal)}</span>
                  </div>
                )}
                {deliveryFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Delivery fee</span><span>{fmt$(deliveryFee)}</span>
                  </div>
                )}
                {tips > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#666' }}>
                    <span>Tip</span><span>{fmt$(tips)}</span>
                  </div>
                )}
                {total > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, marginTop: 6, borderTop: '1px solid #eee', fontSize: 17, fontWeight: 800, color: DARK }}>
                    <span>Total charged</span><span>{fmt$(total)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Invoice download */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1.5px solid #f0f0f0', padding: '14px 20px', marginBottom: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 14, color: '#555', fontWeight: 500 }}>Order invoice</span>
              <a href={`https://api.familymeal.com/public-api/order/${orderRef}/pdf`} target="_blank" rel="noopener noreferrer"
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
