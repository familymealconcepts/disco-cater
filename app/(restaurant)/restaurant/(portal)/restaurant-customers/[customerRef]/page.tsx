'use client'
import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface CustomerOrder {
  orderReference: string
  orderNumber: number
  orderDate: string
  orderTime: string
  orderType: string
  deliveryType: string
  transactionsTotal: number
  orderStatus: string
}

interface CustomerDetails {
  customerReference: string
  username: string
  email: string
  phoneNumber: string
  numberOfOrders: number
  totalspend: number
}

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
}

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-')
  return `${mo}/${day}/${y}`
}

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

const STATUS_LABEL: Record<string, string> = {
  DUE: 'Due', COMPLETED: 'Completed', REOPEN: 'Reopened', REFUND: 'Refunded',
  PARTIAL_REFUND: 'Partial Refunded', CANCELED: 'Canceled', EXPIRED: 'Expired',
  RESERVED: 'Reserved', VOID: 'Voided', PAID: 'Paid', UNPAID: 'Unpaid',
}

const DELIVERY_LABEL: Record<string, string> = {
  OWN_DELIVERY: 'Self-Delivery', NASH_DELIVERY: 'Third-Party Delivery',
  DOOR_DASH_DELIVERY: 'DoorDash', DLIVRD_DELIVERY: 'Expedite',
  PICK_UP: 'Pickup',
}

export default function CustomerDetailPage({ params }: { params: Promise<{ customerRef: string }> }) {
  const { customerRef } = use(params)
  const router = useRouter()
  const [customer, setCustomer] = useState<CustomerDetails | null>(null)
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch(`/api/restaurant/customers?search=${customerRef}&size=1`).then(r => r.ok ? r.json() : null),
      fetch(`/api/restaurant/customers/${customerRef}/orders`).then(r => r.ok ? r.json() : null),
    ]).then(([custData, ordersData]) => {
      // Try to find this customer in the list (fallback — list may not match on ref)
      const found = custData?.content?.find((c: CustomerDetails) => c.customerReference === customerRef)
      setCustomer(found || null)
      setOrders(ordersData?.content || (Array.isArray(ordersData) ? ordersData : []))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [customerRef])

  const colHead: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: '#888',
    padding: '10px 12px', borderBottom: '1px solid #f0f0f0',
    textAlign: 'left', textTransform: 'uppercase', background: '#F7F8FC',
  }
  const cell: React.CSSProperties = { fontSize: 13, color: DARK, padding: '12px' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      {/* Back button */}
      <button
        onClick={() => router.push('/restaurant/restaurant-customers')}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', color: BLUE,
          fontSize: 13, padding: 0, fontFamily: F, fontWeight: 500, marginBottom: 20,
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        ← Back to Customers
      </button>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          {/* Customer header */}
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 4px' }}>
              {customer?.username || 'Customer'}
            </h1>
            <div style={{ fontSize: 13, color: '#888', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {customer?.email && <span>{customer.email}</span>}
              {customer?.phoneNumber && <span>{customer.phoneNumber}</span>}
              {customer?.numberOfOrders !== undefined && (
                <span>{customer.numberOfOrders} order{customer.numberOfOrders !== 1 ? 's' : ''}</span>
              )}
              {customer?.totalspend !== undefined && (
                <span>{fmtCurrency(customer.totalspend)} lifetime</span>
              )}
            </div>
          </div>

          {/* Order History */}
          <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 12px' }}>Order History</h2>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={colHead}>Order #</th>
                  <th style={colHead}>Date</th>
                  <th style={colHead}>Time</th>
                  <th style={colHead}>Type</th>
                  <th style={{ ...colHead, textAlign: 'right' }}>Total</th>
                  <th style={colHead}>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: '#aaa', fontSize: 13 }}>No orders found</td></tr>
                )}
                {orders.map(order => (
                  <tr key={order.orderReference} style={{ borderTop: '1px solid #f5f5f5' }}>
                    <td style={{ ...cell, fontWeight: 600 }}>#{order.orderNumber}</td>
                    <td style={cell}>{fmtDate(order.orderDate)}</td>
                    <td style={cell}>{fmtTime(order.orderTime)}</td>
                    <td style={cell}>{DELIVERY_LABEL[order.deliveryType] || order.orderType || '—'}</td>
                    <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(order.transactionsTotal)}</td>
                    <td style={cell}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                        background: order.orderStatus === 'COMPLETED' ? '#E8F5E9' : order.orderStatus === 'CANCELED' ? '#FFF0F0' : '#F3F4F6',
                        color: order.orderStatus === 'COMPLETED' ? '#2E7D32' : order.orderStatus === 'CANCELED' ? '#C62828' : '#555',
                      }}>
                        {STATUS_LABEL[order.orderStatus] || order.orderStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
