'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRestaurant } from '../context/RestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const GREEN = '#22C55E'
const ORANGE = '#EFB84A'

function StatCard({ label, value, sub, color = DARK }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '20px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 800, color, lineHeight: 1, marginBottom: sub ? 4 : 0 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    PENDING: { bg: '#FEF3C7', color: '#D97706', label: 'Pending' },
    CONFIRMED: { bg: '#DBEAFE', color: '#1D4ED8', label: 'Confirmed' },
    COMPLETED: { bg: '#DCFCE7', color: '#15803D', label: 'Completed' },
    CANCELLED: { bg: '#F3F4F6', color: '#6B7280', label: 'Cancelled' },
    REJECTED: { bg: '#FEE2E2', color: '#DC2626', label: 'Rejected' },
  }
  const s = map[status?.toUpperCase()] || { bg: '#F3F4F6', color: '#6B7280', label: status }
  return (
    <span style={{ background: s.bg, color: s.color, padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
      {s.label}
    </span>
  )
}

function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return d }
}

function fmtMoney(n: number) { return `$${(n || 0).toFixed(2)}` }

function getHour(d: string) {
  try { return new Date(d).getHours() } catch { return 0 }
}

export default function DashboardPage() {
  const { profile } = useRestaurant()
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const loadOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/orders?size=100', { credentials: 'include' })
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || `API error (${res.status})`)
        return
      }
      const data = await res.json()
      const list = data.content || data.orders || data.data || (Array.isArray(data) ? data : [])
      setOrders(list)
      setError(null)
      setLastUpdated(new Date())
    } catch (err) {
      setError('Unable to load orders.')
      console.error('Dashboard orders error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOrders()
    const interval = setInterval(loadOrders, 60_000)
    return () => clearInterval(interval)
  }, [loadOrders])

  const today = new Date().toDateString()
  const todayOrders = orders.filter(o => {
    try { return new Date(o.orderDate || o.deliveryDate || o.createdAt || '').toDateString() === today } catch { return false }
  })
  const pendingOrders = orders.filter(o => (o.status || '').toUpperCase() === 'PENDING')

  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7)
  const weekRevenue = orders
    .filter(o => { try { return new Date(o.orderDate || o.createdAt || '') > weekAgo } catch { return false } })
    .reduce((sum, o) => sum + (o.total || o.totalAmount || 0), 0)

  // Timeline: today's orders sorted by time
  const timeline = [...todayOrders].sort((a, b) => {
    const ta = getHour(a.orderDate || a.deliveryDate || a.createdAt || '')
    const tb = getHour(b.orderDate || b.deliveryDate || b.createdAt || '')
    return ta - tb
  })

  const greetingHour = new Date().getHours()
  const greeting = greetingHour < 12 ? 'Good morning' : greetingHour < 17 ? 'Good afternoon' : 'Good evening'
  const restaurantName = profile?.businessName || profile?.name || 'Restaurant'

  return (
    <div style={{ fontFamily: F }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: 0 }}>
            {greeting}, {restaurantName} 👋
          </h1>
          {lastUpdated && (
            <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>
              Last updated {lastUpdated.toLocaleTimeString()}
            </div>
          )}
        </div>
        <button
          onClick={loadOrders}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e0e0e0', background: '#fff', color: '#555', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
        >
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: 24, fontSize: 13, color: '#DC2626' }}>
          <strong>Could not load orders from FM API:</strong> {error}
          <div style={{ fontSize: 11, marginTop: 4, color: '#9CA3AF' }}>
            This usually means the FM endpoint needs to be confirmed. Check <code>/api/restaurant/orders</code> route configuration.
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 32, flexWrap: 'wrap' }}>
        <StatCard label="Today's Orders" value={loading ? '—' : todayOrders.length} sub="scheduled for today" />
        <StatCard label="Pending Orders" value={loading ? '—' : pendingOrders.length} sub="require action" color={pendingOrders.length > 0 ? ORANGE : DARK} />
        <StatCard label="This Week's Revenue" value={loading ? '—' : `$${weekRevenue.toFixed(0)}`} sub="last 7 days" color={INDIGO} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
        {/* Pending orders */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: 0 }}>
              Pending Orders
              {pendingOrders.length > 0 && (
                <span style={{ marginLeft: 8, background: ORANGE, color: '#fff', borderRadius: 20, fontSize: 11, fontWeight: 700, padding: '2px 8px' }}>
                  {pendingOrders.length}
                </span>
              )}
            </h2>
            <Link href="/restaurant/orders" style={{ fontSize: 12, color: INDIGO, fontWeight: 600, textDecoration: 'none' }}>
              View all →
            </Link>
          </div>

          {loading ? (
            <div style={{ background: '#fff', borderRadius: 12, padding: '32px', textAlign: 'center', color: '#aaa', fontSize: 13, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>Loading…</div>
          ) : pendingOrders.length === 0 ? (
            <div style={{ background: '#fff', borderRadius: 12, padding: '32px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>✅</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: DARK, marginBottom: 4 }}>All caught up!</div>
              <div style={{ fontSize: 12, color: '#aaa' }}>No pending orders require action.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pendingOrders.slice(0, 5).map((o: any, i: number) => (
                <div key={o.reference || o.id || i} style={{ background: '#fff', borderRadius: 12, padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', borderLeft: `4px solid ${ORANGE}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>#{o.reference || o.id || 'Order'}</div>
                    <StatusBadge status={o.status} />
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
                    {o.customerName || o.customer?.name || 'Customer'} · {fmtDate(o.orderDate || o.deliveryDate || o.createdAt || '')}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtMoney(o.total || o.totalAmount || 0)}</div>
                    <Link href="/restaurant/orders" style={{ fontSize: 12, color: INDIGO, fontWeight: 600, textDecoration: 'none' }}>
                      Manage →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Today's timeline */}
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 14px' }}>Upcoming Today</h2>

          {loading ? (
            <div style={{ background: '#fff', borderRadius: 12, padding: '32px', textAlign: 'center', color: '#aaa', fontSize: 13, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>Loading…</div>
          ) : timeline.length === 0 ? (
            <div style={{ background: '#fff', borderRadius: 12, padding: '32px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>📅</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: DARK, marginBottom: 4 }}>No orders today</div>
              <div style={{ fontSize: 12, color: '#aaa' }}>Nothing scheduled for today.</div>
            </div>
          ) : (
            <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
              {timeline.map((o: any, i: number) => {
                const time = (() => { try { return new Date(o.orderDate || o.deliveryDate || o.createdAt || '').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) } catch { return '—' } })()
                return (
                  <div key={o.reference || o.id || i} style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: i < timeline.length - 1 ? '1px solid #f4f4f8' : 'none', gap: 12 }}>
                    <div style={{ width: 60, flexShrink: 0, fontSize: 12, fontWeight: 700, color: INDIGO }}>{time}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>#{o.reference || o.id || 'Order'}</div>
                      <div style={{ fontSize: 11, color: '#888' }}>{o.orderType || 'Order'} · {fmtMoney(o.total || o.totalAmount || 0)}</div>
                    </div>
                    <StatusBadge status={o.status} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
