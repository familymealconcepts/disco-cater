'use client'
import { useState, useEffect, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import GlobalHeader from '../components/GlobalHeader'
import { useAuthContext } from '../context/AuthContext'

declare global { interface Window { Stripe?: (key: string) => any } }

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

type Tab = 'profile' | 'addresses' | 'payment' | 'history'

const inputSt: React.CSSProperties = {
  width: '100%',
  padding: '10px 13px',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: F,
  color: DARK,
  outline: 'none',
  boxSizing: 'border-box',
  background: '#fff',
}

const labelSt: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#555',
  display: 'block',
  marginBottom: 6,
  fontFamily: F,
}

function Toast({ msg, type = 'success' }: { msg: string; type?: 'success' | 'error' }) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: type === 'success' ? '#1D9E75' : '#E24B4A',
      color: '#fff', padding: '11px 22px', borderRadius: 10,
      fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
      whiteSpace: 'nowrap', fontFamily: F,
    }}>
      {msg}
    </div>
  )
}

// ── Profile Tab ───────────────────────────────────────────────────────────────
function ProfileTab({ onToast }: { onToast: (msg: string, type?: 'success' | 'error') => void }) {
  const { user, refreshUser } = useAuthContext()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [deliveryInstructions, setDeliveryInstructions] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (user && !loaded) {
      setFirstName(user.firstName || '')
      setLastName(user.lastName || '')
      setEmail(user.email || '')
      setPhone(user.phoneNumber || '')
      setDeliveryInstructions(user.deliveryInstructions || '')
      setLoaded(true)
    }
  }, [user, loaded])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/fm-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email, phoneNumber: phone, deliveryInstructions }),
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to save')
      await refreshUser()
      onToast('Profile saved successfully')
    } catch {
      onToast('Failed to save profile', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} style={{ maxWidth: 480 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 20 }}>Profile</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={labelSt}>First name</label>
          <input className="account-input" value={firstName} onChange={e => setFirstName(e.target.value)} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Last name</label>
          <input className="account-input" value={lastName} onChange={e => setLastName(e.target.value)} style={inputSt} />
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={labelSt}>Email address</label>
        <input className="account-input" type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputSt} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={labelSt}>Phone number</label>
        <input className="account-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} style={inputSt} />
      </div>
      <div style={{ marginBottom: 20 }}>
        <label style={labelSt}>Delivery instructions</label>
        <textarea
          className="account-input"
          value={deliveryInstructions}
          onChange={e => setDeliveryInstructions(e.target.value)}
          placeholder="e.g. Leave at front desk, call on arrival…"
          rows={3}
          style={{ ...inputSt, resize: 'vertical', padding: '10px 13px' }}
        />
      </div>
      <button
        type="submit"
        disabled={saving}
        style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}
      >
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  )
}

// ── Addresses Tab ─────────────────────────────────────────────────────────────
function AddressesTab({ onToast }: { onToast: (msg: string, type?: 'success' | 'error') => void }) {
  const { user } = useAuthContext()
  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (user?.address) {
      setLine1(user.address)
    }
  }, [user])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/fm-user-addresses', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addressLine1: line1, city, state, zipcode: zip }),
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to save')
      onToast('Address saved')
    } catch {
      onToast('Failed to save address', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} style={{ maxWidth: 480 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 20 }}>Addresses</h2>
      <div style={{ marginBottom: 14 }}>
        <label style={labelSt}>Street address</label>
        <input className="account-input" value={line1} onChange={e => setLine1(e.target.value)} placeholder="123 Main St" style={inputSt} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div>
          <label style={labelSt}>City</label>
          <input className="account-input" value={city} onChange={e => setCity(e.target.value)} placeholder="New York" style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>State</label>
          <input className="account-input" value={state} onChange={e => setState(e.target.value)} placeholder="NY" style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Zip</label>
          <input className="account-input" value={zip} onChange={e => setZip(e.target.value)} placeholder="10001" style={inputSt} />
        </div>
      </div>
      <button
        type="submit"
        disabled={saving}
        style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}
      >
        {saving ? 'Saving…' : 'Save address'}
      </button>
    </form>
  )
}

// ── Payment Tab ───────────────────────────────────────────────────────────────
function PaymentTab({ onToast }: { onToast: (msg: string, type?: 'success' | 'error') => void }) {
  const [card, setCard] = useState<any>(null)
  const [loadingCard, setLoadingCard] = useState(true)
  const [stripeKey, setStripeKey] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const cardElRef = useRef<any>(null)

  useEffect(() => {
    fetch('/api/fm-payment-source', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && (d.brand || d.last4 || d.cardBrand || d.lastFour)) setCard(d) })
      .catch(() => {})
      .finally(() => setLoadingCard(false))

    const envKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    if (envKey) {
      setStripeKey(envKey)
    } else {
      fetch('/api/order/stripe-info', { credentials: 'include' })
        .then(r => r.json())
        .then(d => setStripeKey(d.publishableKey || d.publicKey || ''))
        .catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!showNew || !stripeKey || !cardRef.current) return
    const mount = () => {
      if (!window.Stripe || !cardRef.current || cardElRef.current) return
      stripeRef.current = window.Stripe(stripeKey)
      const elements = stripeRef.current.elements()
      cardElRef.current = elements.create('card', {
        style: { base: { fontFamily: F, fontSize: '15px', color: DARK, '::placeholder': { color: '#bbb' } } },
      })
      cardElRef.current.mount(cardRef.current)
    }
    if (window.Stripe) { mount() }
    else if (!document.getElementById('stripe-js')) {
      const s = document.createElement('script')
      s.id = 'stripe-js'; s.src = 'https://js.stripe.com/v3/'; s.onload = mount
      document.head.appendChild(s)
    }
    return () => { if (cardElRef.current) { cardElRef.current.destroy(); cardElRef.current = null } }
  }, [showNew, stripeKey])

  async function saveCard(e: React.FormEvent) {
    e.preventDefault()
    if (!stripeRef.current || !cardElRef.current) { onToast('Payment form not ready', 'error'); return }
    setSaving(true)
    try {
      const result = await stripeRef.current.createToken(cardElRef.current)
      if (result.error) throw new Error(result.error.message)
      const res = await fetch('/api/fm-payment-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: result.token.id }),
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to save card')
      onToast('Card saved successfully')
      setShowNew(false)
      setCard(null)
      // Reload card
      fetch('/api/fm-payment-source', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && (d.brand || d.last4 || d.cardBrand || d.lastFour)) setCard(d) })
        .catch(() => {})
    } catch (err: any) {
      onToast(err.message || 'Failed to save card', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 20 }}>Payment</h2>

      {loadingCard ? (
        <div style={{ color: '#aaa', fontSize: 13, fontFamily: F }}>Loading…</div>
      ) : card ? (
        <div style={{ border: '1.5px solid #ebebeb', borderRadius: 12, padding: '16px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 26 }}>💳</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{card.brand || card.cardBrand || 'Card'} ···· {card.last4 || card.lastFour}</div>
              {(card.expMonth || card.exp_month) && (
                <div style={{ fontSize: 12, color: '#888' }}>Expires {card.expMonth || card.exp_month}/{String(card.expYear || card.exp_year || '').slice(-2)}</div>
              )}
            </div>
          </div>
          <button onClick={() => setShowNew(true)} style={{ fontSize: 12, color: BLUE, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontFamily: F }}>
            Update
          </button>
        </div>
      ) : (
        <div style={{ border: '1.5px solid #ebebeb', borderRadius: 12, padding: '16px 18px', marginBottom: 16, color: '#888', fontSize: 13, fontFamily: F }}>
          No payment method on file.
        </div>
      )}

      {(!card || showNew) && (
        <form onSubmit={saveCard}>
          <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 12, padding: '14px 16px', marginBottom: 14, background: '#fff' }}>
            <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Card details</div>
            {stripeKey
              ? <div ref={cardRef} style={{ padding: '8px 2px', minHeight: 20 }} />
              : <div style={{ fontSize: 13, color: '#aaa' }}>Loading payment form…</div>}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" disabled={saving} style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}>
              {saving ? 'Saving…' : 'Save card'}
            </button>
            {showNew && (
              <button type="button" onClick={() => setShowNew(false)} style={{ background: 'transparent', border: '1px solid #e0e0e0', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  )
}

// ── Order History Tab ─────────────────────────────────────────────────────────
function HistoryTab() {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<any>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const PAGE_SIZE = 10

  useEffect(() => {
    setLoading(true)
    fetch(`/api/fm-order-history?page=${page}&size=${PAGE_SIZE}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { content: [], totalElements: 0 })
      .then(d => {
        const list = d.content || d.orders || d.data || (Array.isArray(d) ? d : [])
        setOrders(list)
        setTotal(d.totalElements || d.total || list.length)
      })
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [page])

  async function openDetail(ref: string) {
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/fm-order-detail/${ref}`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setSelected(data)
      }
    } catch {}
    setDetailLoading(false)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  function fmtDate(d: string) {
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return d }
  }

  function fmtMoney(n: number) {
    return `$${(n || 0).toFixed(2)}`
  }

  return (
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 20 }}>Order History</h2>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 13, fontFamily: F }}>Loading orders…</div>
      ) : orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🪩</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: DARK, marginBottom: 6 }}>No orders yet</div>
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 20 }}>Start exploring catering options</div>
          <Link href="/fullmap" style={{ padding: '10px 24px', background: BLUE, color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 700, textDecoration: 'none', fontFamily: F }}>
            Browse restaurants
          </Link>
        </div>
      ) : (
        <>
          <div style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
            {orders.map((o: any, i: number) => (
              <div
                key={o.reference || o.id || i}
                onClick={() => openDetail(o.reference || o.id)}
                style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: i < orders.length - 1 ? '1px solid #f0f0f0' : 'none', cursor: 'pointer', gap: 14, transition: 'background 0.1s' }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#fafafa'}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = ''}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{o.restaurantName || o.restaurant?.name || 'Order'}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{fmtDate(o.orderDate || o.createdAt || o.date || '')}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtMoney(o.total || o.totalAmount || 0)}</div>
                  <div style={{ fontSize: 11, marginTop: 2, fontWeight: 600, color: o.status === 'CANCELLED' ? '#E24B4A' : o.status === 'COMPLETED' ? '#1D9E75' : '#888' }}>
                    {o.status || 'Completed'}
                  </div>
                </div>
                <span style={{ color: '#ccc', fontSize: 16 }}>›</span>
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #e0e0e0', background: '#fff', color: page === 0 ? '#ccc' : '#555', cursor: page === 0 ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, fontFamily: F }}>
                ← Prev
              </button>
              <span style={{ fontSize: 12, color: '#888', fontFamily: F }}>{page + 1} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #e0e0e0', background: '#fff', color: page >= totalPages - 1 ? '#ccc' : '#555', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, fontFamily: F }}>
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {/* Order detail panel */}
      {(selected || detailLoading) && (
        <>
          <div onClick={() => setSelected(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 700 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto', zIndex: 701, boxShadow: '0 16px 48px rgba(0,0,0,0.18)', fontFamily: F }}>
            <button onClick={() => setSelected(null)} style={{ position: 'absolute', top: 14, right: 14, background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%', fontSize: 16, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
            {detailLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#888' }}>Loading…</div>
            ) : (
              <>
                <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 16 }}>Order details</div>
                {selected && (
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <tbody>
                      {[
                        ['Restaurant', selected.restaurantName || selected.restaurant?.name || '—'],
                        ['Date', fmtDate(selected.orderDate || selected.createdAt || '')],
                        ['Status', selected.status || '—'],
                        ['Total', fmtMoney(selected.total || selected.totalAmount || 0)],
                        ['Delivery address', selected.deliveryAddress?.addressLine1 || selected.deliveryAddress || '—'],
                      ].map(([l, v]) => (
                        <tr key={l as string}><td style={{ padding: '6px 0', color: '#888', verticalAlign: 'top', width: '40%' }}>{l}</td><td style={{ padding: '6px 0', color: DARK, fontWeight: 600 }}>{v as string}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {selected?.items?.length > 0 && (
                  <>
                    <div style={{ height: 1, background: '#f0f0f0', margin: '12px 0' }} />
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Items</div>
                    {selected.items.map((item: any, i: number) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}>
                        <span style={{ color: '#444' }}>{item.name || item.mealPackageName}</span>
                        <span style={{ color: DARK, fontWeight: 600 }}>{fmtMoney(item.price || item.total || 0)}</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main Account Page ─────────────────────────────────────────────────────────
function AccountPageInner() {
  const { user, isLoading } = useAuthContext()
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab') as Tab | null
  const [activeTab, setActiveTab] = useState<Tab>(tabParam || 'profile')
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  useEffect(() => {
    if (tabParam && ['profile', 'addresses', 'payment', 'history'].includes(tabParam)) {
      setActiveTab(tabParam as Tab)
    }
  }, [tabParam])

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/?login=1')
    }
  }, [user, isLoading, router])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  if (isLoading) {
    return (
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F, color: '#888' }}>Loading…</div>
    )
  }

  if (!user) return null

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'addresses', label: 'Addresses' },
    { id: 'payment', label: 'Payment' },
    { id: 'history', label: 'Order History' },
  ]

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .account-input:focus { border-color: ${INDIGO} !important; box-shadow: 0 0 0 3px rgba(107,110,249,0.1) !important; }
        .account-nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; color: #555; font-family: ${F}; border: none; background: transparent; width: 100%; text-align: left; transition: background 0.1s, color 0.1s; }
        .account-nav-item:hover { background: #f5f5f5; color: #111; }
        .account-nav-item.active { background: #EEEDFE; color: ${INDIGO}; font-weight: 700; }
        @media (max-width: 680px) {
          .account-layout { flex-direction: column !important; }
          .account-sidebar { width: 100% !important; min-width: 0 !important; border-right: none !important; border-bottom: 1px solid #f0f0f0 !important; padding: 12px 18px !important; }
          .account-sidebar-inner { flex-direction: row !important; overflow-x: auto; gap: 4px !important; }
          .account-nav-item { white-space: nowrap; }
        }
      `}</style>
      <div style={{ minHeight: '100svh', display: 'flex', flexDirection: 'column', background: '#fafafa', fontFamily: F }}>
        <GlobalHeader />

        <div className="account-layout" style={{ display: 'flex', flex: 1 }}>
          {/* Sidebar */}
          <div className="account-sidebar" style={{ width: 220, minWidth: 220, borderRight: '1px solid #f0f0f0', background: '#fff', padding: '24px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, padding: '0 6px' }}>Account</div>
            <div className="account-sidebar-inner" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {tabs.map(t => (
                <button key={t.id} className={`account-nav-item${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>

            <div style={{ height: 1, background: '#f0f0f0', margin: '16px 6px' }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, padding: '0 6px' }}>Profile</div>
            <div style={{ padding: '0 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                  {`${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: DARK }}>{user.firstName} {user.lastName}</div>
                  <div style={{ fontSize: 10, color: '#aaa' }}>{user.email}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Main content */}
          <div style={{ flex: 1, padding: '32px 36px', minWidth: 0, overflowY: 'auto' }}>
            {activeTab === 'profile' && <ProfileTab onToast={showToast} />}
            {activeTab === 'addresses' && <AddressesTab onToast={showToast} />}
            {activeTab === 'payment' && <PaymentTab onToast={showToast} />}
            {activeTab === 'history' && <HistoryTab />}
          </div>
        </div>

        {toast && <Toast msg={toast.msg} type={toast.type} />}
      </div>
    </>
  )
}

export default function AccountPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans',sans-serif", color: '#888' }}>Loading…</div>}>
      <AccountPageInner />
    </Suspense>
  )
}
