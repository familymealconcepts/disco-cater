'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'
const DISCO_BLUE = '#5B6FE8'
const DISCO_DARK = '#1A1028'
const DISCO_GOLD = '#EFB84A'
const DISCO_PINK = '#F0468A'
const DISCO_PURPLE = '#6B6EF9'

// ── Types ────────────────────────────────────────────────────────────────────
type Tab = 'orders' | 'subscriptions' | 'history' | 'favorites' | 'account'
type View = 'login' | 'portal'

interface Order {
  id: string
  restaurant: string
  emoji: string
  people: number
  type: 'Delivery' | 'Pickup'
  paymentStatus: 'Paid' | 'Unpaid'
  orderType: string
  amount: number
  date: string
  status: 'active' | 'paused' | 'past'
  note?: string
}

// ── Mock data ─────────────────────────────────────────────────────────────────
const UPCOMING_ORDERS: Order[] = [
  { id: '1', restaurant: 'Taim — Nolita', emoji: '🥙', people: 40, type: 'Delivery', paymentStatus: 'Paid', orderType: 'Weekly recurring', amount: 1240, date: 'May 6, 12:00 PM', status: 'active' },
  { id: '2', restaurant: 'Son del Norte — LES', emoji: '🌮', people: 60, type: 'Delivery', paymentStatus: 'Paid', orderType: 'Event catering', amount: 2100, date: 'May 14, 11:30 AM', status: 'active' },
  { id: '3', restaurant: 'Pecking House', emoji: '🥢', people: 25, type: 'Pickup', paymentStatus: 'Unpaid', orderType: 'Paused — payment failed', amount: 680, date: 'Paused', status: 'paused', note: 'Payment failed' },
]

const PAST_ORDERS: Order[] = [
  { id: '4', restaurant: 'Taim — Nolita', emoji: '🥙', people: 40, type: 'Delivery', paymentStatus: 'Paid', orderType: 'Weekly recurring', amount: 1240, date: 'Apr 29, 2026', status: 'past' },
  { id: '5', restaurant: 'Son del Norte — LES', emoji: '🌮', people: 55, type: 'Delivery', paymentStatus: 'Paid', orderType: 'Event catering', amount: 1925, date: 'Apr 22, 2026', status: 'past' },
  { id: '6', restaurant: 'Taim — Nolita', emoji: '🥙', people: 40, type: 'Delivery', paymentStatus: 'Paid', orderType: 'Weekly recurring', amount: 1240, date: 'Apr 15, 2026', status: 'past' },
  { id: '7', restaurant: 'Pecking House', emoji: '🥢', people: 25, type: 'Pickup', paymentStatus: 'Paid', orderType: 'Bi-weekly', amount: 680, date: 'Apr 8, 2026', status: 'past' },
]

const FAVORITES = [
  { id: '1', name: 'Taim — Nolita', emoji: '🥙', cuisine: 'Mediterranean', location: 'New York, NY' },
  { id: '2', name: 'Son del Norte — LES', emoji: '🌮', cuisine: 'Mexican', location: 'New York, NY' },
  { id: '3', name: 'Pecking House', emoji: '🥢', cuisine: 'Chinese', location: 'New York, NY' },
  { id: '4', name: '5ive Spice LES', emoji: '🌶️', cuisine: 'Asian Fusion', location: 'New York, NY' },
  { id: '5', name: 'Melt Shop', emoji: '🥪', cuisine: 'American', location: 'New York, NY' },
]

// ── Login Screen ──────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('Please enter your email and password.'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/fm-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Invalid email or password.'); setLoading(false); return }
      localStorage.setItem('disco_user', JSON.stringify(data))
      onLogin()
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100svh', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans', sans-serif", background: 'radial-gradient(ellipse at 10% 0%, rgba(107,110,249,0.07) 0%, transparent 55%), radial-gradient(ellipse at 90% 10%, rgba(240,70,138,0.06) 0%, transparent 50%), #fff' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap'); * { box-sizing: border-box; } body { margin: 0; }`}</style>

      {/* Nav */}
      

      {/* Login card */}
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🪩</div>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: DISCO_DARK, margin: '0 0 8px', letterSpacing: '-0.03em' }}>Welcome back</h1>
            <p style={{ fontSize: 14, color: '#888', margin: 0 }}>Sign in to your Disco Cater account</p>
          </div>

          <div style={{ background: '#fff', borderRadius: 20, border: '1.5px solid #eee', padding: 32, boxShadow: '0 4px 32px rgba(107,110,249,0.08)' }}>
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: DISCO_DARK, display: 'block', marginBottom: 6 }}>Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="jamie@acmecorp.com"
                  style={{ width: '100%', padding: '12px 16px', fontSize: 15, border: '1.5px solid #e8e8e8', borderRadius: 12, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK, transition: 'border-color 0.15s' }}
                  onFocus={e => e.target.style.borderColor = DISCO_PURPLE}
                  onBlur={e => e.target.style.borderColor = '#e8e8e8'}
                />
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: DISCO_DARK, display: 'block', marginBottom: 6 }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{ width: '100%', padding: '12px 16px', fontSize: 15, border: '1.5px solid #e8e8e8', borderRadius: 12, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK, transition: 'border-color 0.15s' }}
                  onFocus={e => e.target.style.borderColor = DISCO_PURPLE}
                  onBlur={e => e.target.style.borderColor = '#e8e8e8'}
                />
              </div>
              {error && <p style={{ fontSize: 13, color: DISCO_PINK, margin: '0 0 16px', textAlign: 'center' }}>{error}</p>}
              <button
                type="submit"
                disabled={loading}
                style={{ width: '100%', padding: '14px', fontSize: 15, fontWeight: 700, color: '#fff', background: loading ? '#aaa' : DISCO_DARK, border: 'none', borderRadius: 12, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", transition: 'background 0.15s' }}
                onMouseOver={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = DISCO_PURPLE }}
                onMouseOut={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = DISCO_DARK }}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid #f0f0f0', textAlign: 'center' }}>
              <a href="#" style={{ fontSize: 13, color: DISCO_PURPLE, textDecoration: 'none', fontWeight: 500 }}>Forgot your password?</a>
            </div>
          </div>

          <p style={{ textAlign: 'center', fontSize: 13, color: '#888', marginTop: 20 }}>
            Don&apos;t have an account?{' '}
            <a href="#" style={{ color: DISCO_PURPLE, textDecoration: 'none', fontWeight: 600 }}>Create one</a>
          </p>
        </div>
      </main>
    </div>
  )
}

// ── Order Card ────────────────────────────────────────────────────────────────
function OrderCard({ order, onSelect }: { order: Order; onSelect: (o: Order) => void }) {
  const isPaused = order.status === 'paused'
  return (
    <div
      onClick={() => onSelect(order)}
      style={{
        background: '#fff',
        border: `1.5px solid ${isPaused ? '#FFE0E8' : '#f0f0f0'}`,
        borderRadius: 16,
        padding: '16px 20px',
        cursor: 'pointer',
        transition: 'all 0.15s',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
      onMouseOver={e => { (e.currentTarget as HTMLDivElement).style.borderColor = isPaused ? DISCO_PINK : DISCO_PURPLE; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 20px rgba(107,110,249,0.10)' }}
      onMouseOut={e => { (e.currentTarget as HTMLDivElement).style.borderColor = isPaused ? '#FFE0E8' : '#f0f0f0'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
    >
      <div style={{ fontSize: 28, flexShrink: 0, width: 48, height: 48, background: isPaused ? '#FFF0F3' : '#F5F4FF', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{order.emoji}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK, marginBottom: 2 }}>{order.restaurant}</div>
        <div style={{ fontSize: 13, color: '#888' }}>{order.people} people · {order.type} · {order.orderType}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK }}>${order.amount.toLocaleString()}</div>
        <div style={{ fontSize: 12, color: isPaused ? DISCO_PINK : '#888', fontWeight: isPaused ? 600 : 400, marginTop: 2 }}>{order.date}</div>
      </div>
    </div>
  )
}

// ── Order Detail Modal ────────────────────────────────────────────────────────
function OrderDetail({ order, onClose }: { order: Order; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(26,16,40,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: '0' }}
      onClick={onClose}>
      <div
        style={{ background: '#fff', borderRadius: '24px 24px 0 0', width: '100%', maxWidth: 560, padding: 32, maxHeight: '85vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 28, width: 48, height: 48, background: '#F5F4FF', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{order.emoji}</div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, color: DISCO_DARK }}>{order.restaurant}</div>
              <div style={{ fontSize: 13, color: '#888' }}>{order.people} people · {order.orderType}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: '#f5f5f5', cursor: 'pointer', fontSize: 16, color: '#666', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {order.status === 'paused' && (
          <div style={{ background: '#FFF0F3', border: '1px solid #FFD0DC', borderRadius: 12, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: DISCO_PINK, fontWeight: 600 }}>
            ⚠️ Payment failed — your order is paused. Update your card to resume.
          </div>
        )}

        <div style={{ background: '#F8F8FF', borderRadius: 14, padding: 20, marginBottom: 20 }}>
          {[
            ['Amount', `$${order.amount.toLocaleString()}`],
            ['Type', order.type],
            ['Service', order.orderType],
            ['Date', order.date],
            ['Payment', order.paymentStatus],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #eeebff' }}>
              <span style={{ fontSize: 13, color: '#888' }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: DISCO_DARK }}>{value}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          {order.status === 'paused' ? (
            <button style={{ flex: 1, padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: DISCO_BLUE, border: 'none', borderRadius: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Update card & resume</button>
          ) : order.status === 'active' ? (
            <>
              <button style={{ flex: 1, padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: DISCO_BLUE, border: 'none', borderRadius: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Edit order</button>
              <button style={{ flex: 1, padding: '13px', fontSize: 14, fontWeight: 700, color: '#666', background: '#f5f5f5', border: 'none', borderRadius: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Skip next</button>
            </>
          ) : (
            <button style={{ flex: 1, padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: DISCO_BLUE, border: 'none', borderRadius: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Reorder</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Orders Tab ────────────────────────────────────────────────────────────────
function OrdersTab({ realOrders = [], ordersLoading = false }: { realOrders?: any[], ordersLoading?: boolean }) {
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [showPast, setShowPast] = useState(false)

  return (
    <div>
      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Active orders', value: '3', sub: '2 recurring · 1 one-time' },
          { label: 'Total orders', value: '47', sub: 'since Jan 2025' },
          { label: 'Next order', value: 'May 6', sub: 'Taim — Nolita · 12:00 PM' },
        ].map(s => (
          <div key={s.label} style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 16, padding: '16px 20px' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: DISCO_DARK, letterSpacing: '-0.03em' }}>{s.value}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
            <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Upcoming */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK, margin: 0 }}>Your Orders</h3>
        <Link href="/fullmap" style={{ fontSize: 13, color: DISCO_PURPLE, textDecoration: 'none', fontWeight: 600 }}>+ New order</Link>
      </div>
      {ordersLoading && (
        <div style={{ textAlign: 'center', padding: '48px 0', color: '#bbb', fontSize: 14 }}>Loading your orders…</div>
      )}
      {!ordersLoading && realOrders.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📦</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#888', marginBottom: 8 }}>No orders yet</div>
          <Link href="/fullmap" style={{ fontSize: 14, color: DISCO_PURPLE, textDecoration: 'none', fontWeight: 600 }}>Browse restaurants →</Link>
        </div>
      )}
      {!ordersLoading && realOrders.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          {realOrders.map((o: any) => (
            <div key={o.reference || o.id} style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 16, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer' }}>
              <div style={{ fontSize: 28, flexShrink: 0, width: 48, height: 48, background: '#F5F4FF', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🍽️</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK, marginBottom: 2 }}>{o.restaurantName || o.restaurant?.name || 'Restaurant'}</div>
                <div style={{ fontSize: 13, color: '#888' }}>{o.orderType || o.type || ''} · {o.orderDate || o.date || ''}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK }}>${((o.total || o.amount || 0) / 100).toFixed(2)}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{o.status || ''}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Past */}
      <button
        onClick={() => setShowPast(v => !v)}
        style={{ fontSize: 14, fontWeight: 600, color: '#888', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}
      >
        Past orders ({PAST_ORDERS.length}) {showPast ? '▴' : '▾'}
      </button>
      {showPast && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          {PAST_ORDERS.map(o => <OrderCard key={o.id} order={o} onSelect={setSelectedOrder} />)}
        </div>
      )}

      {/* Discover CTA */}
      <Link href="/fullmap" style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(135deg, #F5F4FF 0%, #FFF0F8 100%)', border: '1.5px solid #eeebff', borderRadius: 16, padding: '16px 20px', textDecoration: 'none', marginBottom: 8 }}>
        <span style={{ fontSize: 22 }}>🪩</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: DISCO_DARK }}>Discover more restaurants</div>
          <div style={{ fontSize: 13, color: '#888' }}>Find new catering options on Disco Cater →</div>
        </div>
      </Link>

      {selectedOrder && <OrderDetail order={selectedOrder} onClose={() => setSelectedOrder(null)} />}
    </div>
  )
}

// ── Subscriptions Tab ─────────────────────────────────────────────────────────
function SubscriptionsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[
        { emoji: '🥙', name: 'Taim — Nolita', people: 40, type: 'Delivery', schedule: 'Every Tuesday · 12:00 PM', amount: 1240, next: 'May 6', status: 'active' },
        { emoji: '🥢', name: 'Pecking House', people: 25, type: 'Pickup', schedule: 'Bi-weekly · Paused — payment failed', amount: 680, next: 'Paused', status: 'paused' },
      ].map(sub => (
        <div key={sub.name} style={{ background: '#fff', border: `1.5px solid ${sub.status === 'paused' ? '#FFE0E8' : '#f0f0f0'}`, borderRadius: 16, padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ fontSize: 26, width: 44, height: 44, background: sub.status === 'paused' ? '#FFF0F3' : '#F5F4FF', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{sub.emoji}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK, marginBottom: 2 }}>{sub.name}</div>
              <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>{sub.people} people · {sub.type}</div>
              <div style={{ fontSize: 13, color: sub.status === 'paused' ? DISCO_PINK : '#666', fontWeight: sub.status === 'paused' ? 600 : 400, marginBottom: 16 }}>{sub.schedule}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {sub.status === 'paused' ? (
                  <button style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700, color: '#fff', background: DISCO_BLUE, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Update card</button>
                ) : (
                  <>
                    <button style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, color: DISCO_DARK, background: '#f5f5f5', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Edit</button>
                    <button style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, color: DISCO_DARK, background: '#f5f5f5', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Skip next</button>
                  </>
                )}
                <button style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, color: '#999', background: 'none', border: '1.5px solid #eee', borderRadius: 10, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Cancel</button>
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: DISCO_DARK }}>${sub.amount.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>Next: {sub.next}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Favorites Tab ─────────────────────────────────────────────────────────────
function FavoritesTab() {
  const [favorites, setFavorites] = useState(FAVORITES)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {favorites.map(f => (
        <div key={f.id} style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 16, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 24, width: 44, height: 44, background: '#F5F4FF', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{f.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK }}>{f.name}</div>
            <div style={{ fontSize: 13, color: '#888' }}>{f.cuisine} · {f.location}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/fullmap" style={{ padding: '8px 14px', fontSize: 13, fontWeight: 700, color: '#fff', background: DISCO_BLUE, border: 'none', borderRadius: 10, cursor: 'pointer', textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}>Order</Link>
            <button
              onClick={() => setFavorites(prev => prev.filter(x => x.id !== f.id))}
              style={{ width: 34, height: 34, borderRadius: 10, border: '1.5px solid #eee', background: '#fff', cursor: 'pointer', color: '#ccc', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title="Remove favorite"
            >✕</button>
          </div>
        </div>
      ))}
      {favorites.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#bbb' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🤍</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#888' }}>No saved restaurants yet</div>
          <Link href="/fullmap" style={{ display: 'inline-block', marginTop: 16, padding: '10px 20px', background: DISCO_DARK, color: '#fff', borderRadius: 10, textDecoration: 'none', fontSize: 14, fontWeight: 700 }}>Browse restaurants</Link>
        </div>
      )}
    </div>
  )
}

// ── Account Tab ───────────────────────────────────────────────────────────────
function AccountTab({ onSignOut }: { onSignOut: () => void }) {
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [profileLoading, setProfileLoading] = useState(true)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('disco_user')
      if (!stored) return
      const user = JSON.parse(stored)
      if (!user?.token) return

      // Use data stored at login time
      setFirstName(user.firstName || '')
      setLastName(user.lastName || '')
      setEmail(user.email || '')
      setPhone(user.phoneNumber || '')
      setProfileLoading(false)
    } catch {
      setProfileLoading(false)
    }
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const stored = localStorage.getItem('disco_user')
      if (!stored) return
      const user = JSON.parse(stored)
      await fetch('/api/fm-user', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ firstName, lastName, email, phoneNumber: phone }),
      })
      // Update stored user
      localStorage.setItem('disco_user', JSON.stringify({ ...user, firstName, lastName, email }))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      console.error('Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>


      {/* Personal info */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 16, padding: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK, margin: '0 0 20px' }}>Personal info</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
          {[['First name', firstName, setFirstName], ['Last name', lastName, setLastName]].map(([label, val, setter]) => (
            <div key={label as string}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>{label as string}</label>
              <input value={val as string} onChange={e => (setter as any)(e.target.value)} style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #eee', borderRadius: 10, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK }} />
            </div>
          ))}
        </div>
        {[['Email address', email, setEmail, 'email'], ['Phone number', phone, setPhone, 'tel']].map(([label, val, setter, type]) => (
          <div key={label as string} style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>{label as string}</label>
            <input type={type as string} value={val as string} onChange={e => (setter as any)(e.target.value)} style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #eee', borderRadius: 10, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK }} />
          </div>
        ))}
        <button
          onClick={handleSave}
          style={{ padding: '11px 24px', fontSize: 14, fontWeight: 700, color: '#fff', background: saved ? '#22c55e' : DISCO_DARK, border: 'none', borderRadius: 10, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", transition: 'background 0.2s' }}
        >{saved ? '✓ Saved' : saving ? 'Saving…' : 'Save changes'}</button>
      </div>

      {/* Payment methods */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 16, padding: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK, margin: '0 0 16px' }}>Payment methods</h3>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f5f5f5' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 28, background: '#1A1F71', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', letterSpacing: '0.5px' }}>VISA</span>
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: DISCO_DARK }}>Visa ending in 4821</div>
              <div style={{ fontSize: 12, color: '#888' }}>Expires 09/28 · Default</div>
            </div>
          </div>
          <button style={{ padding: '7px 14px', fontSize: 13, fontWeight: 600, color: DISCO_PURPLE, background: '#F5F4FF', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Update</button>
        </div>
        <button style={{ marginTop: 14, padding: '10px 18px', fontSize: 13, fontWeight: 700, color: DISCO_DARK, background: '#f5f5f5', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>+ Add payment method</button>
      </div>

      {/* Sign out */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 16, padding: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: DISCO_DARK, margin: '0 0 8px' }}>Sign out</h3>
        <p style={{ fontSize: 13, color: '#888', margin: '0 0 16px' }}>You will need to sign in again to access your orders and saved restaurants.</p>
        <button onClick={onSignOut} style={{ padding: '11px 24px', fontSize: 14, fontWeight: 700, color: '#666', background: '#f5f5f5', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Sign out</button>
      </div>

      {/* Danger zone */}
      <div style={{ background: '#fff', border: '1.5px solid #FFE0E8', borderRadius: 16, padding: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: DISCO_PINK, margin: '0 0 8px' }}>Danger zone</h3>
        <p style={{ fontSize: 13, color: '#888', margin: '0 0 16px' }}>Permanently delete your Disco Cater account and all associated order history. This cannot be undone.</p>
        <button style={{ padding: '11px 24px', fontSize: 14, fontWeight: 700, color: DISCO_PINK, background: '#FFF0F3', border: '1.5px solid #FFD0DC', borderRadius: 10, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>Delete my account</button>
      </div>
    </div>
  )
}

// ── Main Portal ───────────────────────────────────────────────────────────────
function Portal({ onSignOut }: { onSignOut: () => void }) {
  const [realOrders, setRealOrders] = useState<any[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('disco_user')
      if (!stored) return
      const user = JSON.parse(stored)
      if (!user?.token) return

      fetch('/api/fm-orders', {
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'x-refresh-token': user.refreshToken || ''
        }
      })
        .then(r => r.json())
        .then(data => {
          // Update token if refreshed
          if (data._newToken) {
            const updated = { ...user, token: data._newToken }
            localStorage.setItem('disco_user', JSON.stringify(updated))
          }
          console.log('Orders API response:', JSON.stringify(data).slice(0, 300))
          const orders = data.content || data.orders || data || []
          setRealOrders(Array.isArray(orders) ? orders : [])
          setOrdersLoading(false)
        })
        .catch(() => setOrdersLoading(false))
    } catch {
      setOrdersLoading(false)
    }
  }, [])
  const [activeTab, setActiveTab] = useState<Tab>('orders')
  const [menuOpen, setMenuOpen] = useState(false)

  const tabs: { id: Tab; label: string; emoji: string }[] = [
    { id: 'orders', label: 'Orders', emoji: '📦' },
    { id: 'subscriptions', label: 'Subscriptions', emoji: '🔁' },
    { id: 'history', label: 'History', emoji: '🕐' },
    { id: 'favorites', label: 'Favorites', emoji: '❤️' },
    { id: 'account', label: 'Account', emoji: '👤' },
  ]

  return (
    <div style={{ minHeight: '100svh', background: '#F8F8FC', fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .portal-tab { transition: all 0.15s; }
        .portal-tab:hover { background: #F0F0FF !important; color: #6B6EF9 !important; }
        @media (max-width: 768px) {
          .portal-sidebar { display: none !important; }
          .portal-mobile-nav { display: flex !important; }
          .portal-content { margin-left: 0 !important; padding: 16px !important; }
          .portal-header { padding: 14px 16px !important; }
        }
        @media (min-width: 769px) {
          .portal-mobile-nav { display: none !important; }
        }
      `}</style>

      {/* Header */}
      

      <div style={{ display: 'flex', minHeight: 'calc(100svh - 65px)' }}>
        {/* Sidebar */}
        <aside className="portal-sidebar" style={{ width: 220, background: '#fff', borderRight: '1.5px solid #f0f0f0', padding: '24px 12px', position: 'sticky', top: 65, height: 'calc(100svh - 65px)', overflowY: 'auto', flexShrink: 0 }}>
          <div style={{ marginBottom: 8, padding: '0 8px', fontSize: 11, fontWeight: 700, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.08em' }}>My Account</div>
          {tabs.map(tab => (
            <button
              key={tab.id}
              className="portal-tab"
              onClick={() => setActiveTab(tab.id)}
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: 14,
                fontWeight: activeTab === tab.id ? 700 : 500,
                color: activeTab === tab.id ? DISCO_PURPLE : '#555',
                background: activeTab === tab.id ? '#F0F0FF' : 'transparent',
                border: 'none',
                borderRadius: 10,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: "'DM Sans', sans-serif",
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 2,
              }}
            >
              <span style={{ fontSize: 16 }}>{tab.emoji}</span>
              {tab.label}
              {tab.id === 'account' && <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#fff', background: DISCO_PINK, borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>1</span>}
            </button>
          ))}
        </aside>

        {/* Content */}
        <main className="portal-content" style={{ flex: 1, padding: '32px', maxWidth: 760, margin: '0 auto' }}>
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: DISCO_DARK, margin: '0 0 4px', letterSpacing: '-0.03em' }}>
              {tabs.find(t => t.id === activeTab)?.label}
            </h1>
            {activeTab === 'orders' && <p style={{ fontSize: 14, color: '#888', margin: 0 }}>3 upcoming · 2 recurring</p>}
          </div>

          {activeTab === 'orders' && <OrdersTab realOrders={realOrders} ordersLoading={ordersLoading} />}
          {activeTab === 'subscriptions' && <SubscriptionsTab />}
          {activeTab === 'history' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[...UPCOMING_ORDERS, ...PAST_ORDERS].map(o => <OrderCard key={o.id} order={o} onSelect={() => {}} />)}
            </div>
          )}
          {activeTab === 'favorites' && <FavoritesTab />}
          {activeTab === 'account' && <AccountTab onSignOut={onSignOut} />}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="portal-mobile-nav" style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, background: '#fff', borderTop: '1.5px solid #f0f0f0', padding: '8px 0', paddingBottom: 'max(8px, env(safe-area-inset-bottom))', zIndex: 100, justifyContent: 'space-around' }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
            <span style={{ fontSize: 20 }}>{tab.emoji}</span>
            <span style={{ fontSize: 10, fontWeight: activeTab === tab.id ? 700 : 500, color: activeTab === tab.id ? DISCO_PURPLE : '#888' }}>{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function PortalPage() {
  const [view, setView] = useState<View>('login')

  useEffect(() => {
    try {
      const stored = localStorage.getItem('disco_user')
      if (stored) {
        const user = JSON.parse(stored)
        if (user?.token) setView('portal')
      }
    } catch {}
  }, [])

  if (view === 'login') return <LoginScreen onLogin={() => setView('portal')} />
  return <Portal onSignOut={() => {
    localStorage.removeItem('disco_user')
    window.location.href = '/'
  }} />
}
