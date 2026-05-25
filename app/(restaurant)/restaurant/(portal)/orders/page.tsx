'use client'
import { useState, useEffect, useCallback, useRef } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const PINK = '#F0468A'

type Status = 'ALL' | 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'
const TABS: Status[] = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'ALL']

const REJECT_REASONS = [
  'Unavailable date',
  'Item unavailable',
  'Outside delivery area',
  'At capacity',
  'Other',
]

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    PENDING:   { bg: '#FEF3C7', color: '#D97706' },
    CONFIRMED: { bg: '#DBEAFE', color: '#1D4ED8' },
    COMPLETED: { bg: '#DCFCE7', color: '#15803D' },
    CANCELLED: { bg: '#F3F4F6', color: '#6B7280' },
    REJECTED:  { bg: '#FEE2E2', color: '#DC2626' },
  }
  const s = map[status?.toUpperCase()] || { bg: '#F3F4F6', color: '#6B7280' }
  return (
    <span style={{ background: s.bg, color: s.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  )
}

function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) } catch { return d }
}
function fmtTime(d: string) {
  try { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}
function fmtMoney(n: number) { return `$${(n || 0).toFixed(2)}` }

export default function OrdersPage() {
  const [tab, setTab] = useState<Status>('PENDING')
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<any>(null)
  const [rejectTarget, setRejectTarget] = useState<any>(null)
  const [rejectReason, setRejectReason] = useState(REJECT_REASONS[0])
  const [actionLoading, setActionLoading] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [prevCount, setPrevCount] = useState<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const PAGE_SIZE = 20

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  const loadOrders = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) })
      if (tab !== 'ALL') params.set('status', tab)
      if (search.trim()) params.set('search', search.trim())

      const res = await fetch(`/api/restaurant/orders?${params}`, { credentials: 'include' })
      if (!res.ok) {
        const d = await res.json()
        setError(d.error || `API error (${res.status})`)
        return
      }
      const data = await res.json()
      const list = data.content || data.orders || data.data || (Array.isArray(data) ? data : [])
      const tot = data.totalElements || data.total || list.length

      // Check for new pending orders
      if (tab === 'PENDING' && prevCount !== null && list.length > prevCount) {
        showToast(`New order received! 🔔`, 'success')
        if (Notification.permission === 'granted') {
          new Notification('New order received!', { body: 'A new pending order needs your attention.' })
        }
      }
      if (tab === 'PENDING') setPrevCount(list.length)

      setOrders(list)
      setTotal(tot)
    } catch (err) {
      setError('Unable to fetch orders.')
      console.error('Orders load error:', err)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [tab, page, search, prevCount])

  useEffect(() => {
    loadOrders()
  }, [tab, page])

  // Real-time polling every 30s
  useEffect(() => {
    const id = setInterval(() => loadOrders(true), 30_000)
    return () => clearInterval(id)
  }, [loadOrders])

  // Search with debounce
  useEffect(() => {
    const id = setTimeout(() => { setPage(0); loadOrders() }, 400)
    return () => clearTimeout(id)
  }, [search])

  async function loadDetail(ref: string) {
    setDetailLoading(true)
    setDetail({})
    try {
      const res = await fetch(`/api/restaurant/orders/${ref}`, { credentials: 'include' })
      if (res.ok) setDetail(await res.json())
      else setDetail({ _error: `Could not load detail (${res.status})` })
    } catch {
      setDetail({ _error: 'Failed to load order detail.' })
    } finally {
      setDetailLoading(false)
    }
  }

  async function confirmOrder() {
    if (!confirmTarget) return
    setActionLoading(true)
    try {
      const res = await fetch(`/api/restaurant/orders/${confirmTarget.reference || confirmTarget.id}/confirm`, {
        method: 'POST', credentials: 'include',
      })
      if (res.ok) {
        showToast('Order confirmed!')
        setConfirmTarget(null)
        loadOrders()
      } else {
        const d = await res.json()
        showToast(d.error || 'Failed to confirm order.', 'error')
      }
    } catch {
      showToast('Failed to confirm order.', 'error')
    } finally {
      setActionLoading(false)
    }
  }

  async function rejectOrder() {
    if (!rejectTarget) return
    setActionLoading(true)
    try {
      const res = await fetch(`/api/restaurant/orders/${rejectTarget.reference || rejectTarget.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason: rejectReason }),
      })
      if (res.ok) {
        showToast('Order rejected.')
        setRejectTarget(null)
        loadOrders()
      } else {
        const d = await res.json()
        showToast(d.error || 'Failed to reject order.', 'error')
      }
    } catch {
      showToast('Failed to reject order.', 'error')
    } finally {
      setActionLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .r-tab { padding: 8px 18px; border-radius: 8px; border: none; background: transparent; font-size: 13px; font-weight: 600; cursor: pointer; color: #888; font-family: ${F}; transition: background 0.12s, color 0.12s; }
        .r-tab.active { background: ${INDIGO}; color: #fff; }
        .r-tab:not(.active):hover { background: #f0f0f8; color: #333; }
        .r-input { padding: 9px 13px; border: 1.5px solid #e0e0e0; border-radius: 9px; font-size: 13px; font-family: ${F}; color: ${DARK}; outline: none; background: #fff; }
        .r-input:focus { border-color: ${INDIGO}; }
        .r-order-card { background: #fff; border-radius: 12px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transition: box-shadow 0.12s; }
        .r-order-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .r-btn-primary { background: ${INDIGO}; color: #fff; border: none; border-radius: 8px; padding: '8px 16px'; font-size: 12px; font-weight: 700; cursor: pointer; font-family: ${F}; }
        .r-btn-danger { background: ${PINK}; color: #fff; border: none; border-radius: 8px; padding: '8px 16px'; font-size: 12px; font-weight: 700; cursor: pointer; font-family: ${F}; }
        .r-btn-ghost { background: transparent; border: 1.5px solid #e0e0e0; border-radius: 8px; color: #555; font-size: 12px; font-weight: 600; cursor: pointer; font-family: ${F}; }
      `}</style>

      <div style={{ fontFamily: F }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, marginBottom: 20, marginTop: 0 }}>Orders</h1>

        {/* Tabs + search */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', gap: 4, background: '#fff', padding: 4, borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', flexWrap: 'wrap' }}>
            {TABS.map(t => (
              <button key={t} className={`r-tab${tab === t ? ' active' : ''}`} onClick={() => { setTab(t); setPage(0) }}>
                {t === 'ALL' ? 'All Orders' : t.charAt(0) + t.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="r-input" placeholder="Search by ref or customer…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} />
            <button onClick={() => loadOrders()} style={{ padding: '9px 14px', borderRadius: 9, border: '1px solid #e0e0e0', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: F, color: '#555' }}>
              Refresh
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#DC2626' }}>
            <strong>API Error:</strong> {error}
            <div style={{ fontSize: 11, marginTop: 4, color: '#9CA3AF' }}>
              The FM endpoint at <code>/api/restaurant/orders</code> may need to be updated with the correct path.
            </div>
          </div>
        )}

        {/* Orders list */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#aaa', fontSize: 14 }}>Loading orders…</div>
        ) : orders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 6 }}>No {tab === 'ALL' ? '' : tab.toLowerCase() + ' '}orders</div>
            <div style={{ fontSize: 13, color: '#aaa' }}>
              {tab === 'PENDING' ? 'All caught up — no orders need action.' : `No orders with status "${tab.toLowerCase()}".`}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {orders.map((o: any, i: number) => (
              <div key={o.reference || o.id || i} className="r-order-card">
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 800, color: DARK }}>#{o.reference || o.id || 'Order'}</span>
                    <span style={{ marginLeft: 12, fontSize: 12, color: '#888' }}>
                      {fmtDate(o.orderDate || o.deliveryDate || o.createdAt || '')}
                      {(o.orderTime || o.deliveryTime) && ` · ${o.orderTime || o.deliveryTime}`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#888', background: '#f4f4f8', padding: '3px 9px', borderRadius: 20 }}>
                      {o.orderType || o.type || 'ORDER'}
                    </span>
                    <StatusBadge status={o.status} />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 13, color: '#555' }}>
                  <div><span style={{ color: '#aaa', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Customer</span><br />{o.customerName || o.customer?.name || o.contactName || '—'}</div>
                  {o.deliveryAddress && <div><span style={{ color: '#aaa', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Delivery</span><br />{o.deliveryAddress?.addressLine1 || o.deliveryAddress || '—'}</div>}
                </div>

                {o.items?.length > 0 && (
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
                    {o.items.slice(0, 3).map((it: any, j: number) => (
                      <span key={j}>{it.name || it.mealPackageName || 'Item'}{it.quantity > 1 ? ` ×${it.quantity}` : ''}{j < Math.min(o.items.length, 3) - 1 ? ', ' : ''}</span>
                    ))}
                    {o.items.length > 3 && ` +${o.items.length - 3} more`}
                  </div>
                )}

                {o.specialInstructions && (
                  <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#92400E', marginBottom: 12 }}>
                    <strong>Special instructions:</strong> {o.specialInstructions}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ fontSize: 13, color: '#888' }}>
                    Subtotal: <strong style={{ color: DARK }}>{fmtMoney(o.subtotal || o.subTotal || 0)}</strong>
                    {(o.serviceFee || o.fee) ? ` · Fee: ${fmtMoney(o.serviceFee || o.fee)}` : ''}
                    {' · '}
                    <strong style={{ fontSize: 14, color: DARK }}>Total: {fmtMoney(o.total || o.totalAmount || 0)}</strong>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => loadDetail(o.reference || o.id)}
                      style={{ padding: '7px 14px', borderRadius: 8, border: '1.5px solid #e0e0e0', background: '#fff', color: '#555', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
                    >
                      Details
                    </button>
                    {(o.status || '').toUpperCase() === 'PENDING' && (
                      <>
                        <button
                          onClick={() => setRejectTarget(o)}
                          style={{ padding: '7px 14px', borderRadius: 8, border: `1.5px solid ${PINK}`, background: '#fff', color: PINK, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }}
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => setConfirmTarget(o)}
                          style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: INDIGO, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }}
                        >
                          Confirm Order
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 24 }}>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #e0e0e0', background: '#fff', color: page === 0 ? '#ccc' : '#555', cursor: page === 0 ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, fontFamily: F }}>← Prev</button>
            <span style={{ padding: '7px 12px', fontSize: 12, color: '#888', fontFamily: F }}>{page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #e0e0e0', background: '#fff', color: page >= totalPages - 1 ? '#ccc' : '#555', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, fontFamily: F }}>Next →</button>
          </div>
        )}
      </div>

      {/* Confirm dialog */}
      {confirmTarget && (
        <>
          <div onClick={() => setConfirmTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 700 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 16, padding: 28, width: 400, zIndex: 701, boxShadow: '0 16px 48px rgba(0,0,0,0.18)', fontFamily: F }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: DARK, marginTop: 0 }}>Confirm this order?</h3>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>
              Order <strong>#{confirmTarget.reference || confirmTarget.id}</strong> from{' '}
              {confirmTarget.customerName || 'this customer'} for{' '}
              <strong>{fmtMoney(confirmTarget.total || confirmTarget.totalAmount || 0)}</strong> will be accepted.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmTarget(null)} style={{ padding: '9px 18px', border: '1px solid #e0e0e0', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#555', fontFamily: F }}>Cancel</button>
              <button onClick={confirmOrder} disabled={actionLoading} style={{ padding: '9px 20px', background: INDIGO, color: '#fff', border: 'none', borderRadius: 8, cursor: actionLoading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: F, opacity: actionLoading ? 0.6 : 1 }}>
                {actionLoading ? 'Confirming…' : 'Yes, Confirm'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Reject dialog */}
      {rejectTarget && (
        <>
          <div onClick={() => setRejectTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 700 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 16, padding: 28, width: 400, zIndex: 701, boxShadow: '0 16px 48px rgba(0,0,0,0.18)', fontFamily: F }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: DARK, marginTop: 0 }}>Reject this order?</h3>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 14 }}>
              Order <strong>#{rejectTarget.reference || rejectTarget.id}</strong> will be rejected. Please select a reason:
            </p>
            <select
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              style={{ width: '100%', padding: '10px 13px', border: '1.5px solid #e0e0e0', borderRadius: 9, fontSize: 13, fontFamily: F, marginBottom: 20, color: DARK, outline: 'none' }}
            >
              {REJECT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setRejectTarget(null)} style={{ padding: '9px 18px', border: '1px solid #e0e0e0', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#555', fontFamily: F }}>Cancel</button>
              <button onClick={rejectOrder} disabled={actionLoading} style={{ padding: '9px 20px', background: PINK, color: '#fff', border: 'none', borderRadius: 8, cursor: actionLoading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: F, opacity: actionLoading ? 0.6 : 1 }}>
                {actionLoading ? 'Rejecting…' : 'Reject Order'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Detail modal */}
      {detail !== null && (
        <>
          <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 700 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto', zIndex: 701, boxShadow: '0 16px 48px rgba(0,0,0,0.18)', fontFamily: F }}>
            <button onClick={() => setDetail(null)} style={{ position: 'absolute', top: 14, right: 14, background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%', fontSize: 16, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
            {detailLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#aaa' }}>Loading…</div>
            ) : detail._error ? (
              <div style={{ color: '#DC2626', fontSize: 13 }}>{detail._error}</div>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color: DARK, marginBottom: 16 }}>
                  Order #{detail.reference || detail.id}
                  <span style={{ marginLeft: 12 }}><StatusBadge status={detail.status} /></span>
                </div>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 16 }}>
                  <tbody>
                    {[
                      ['Customer', detail.customerName || detail.customer?.name || '—'],
                      ['Date', fmtDate(detail.orderDate || detail.deliveryDate || detail.createdAt || '')],
                      ['Time', fmtTime(detail.orderDate || detail.deliveryDate || detail.createdAt || '') || '—'],
                      ['Type', detail.orderType || '—'],
                      ['Delivery address', detail.deliveryAddress?.addressLine1 || detail.deliveryAddress || '—'],
                      ['Contact', detail.customerPhone || detail.customer?.phone || '—'],
                    ].map(([l, v]) => (
                      <tr key={l as string}>
                        <td style={{ padding: '5px 0', color: '#888', width: '38%', verticalAlign: 'top', fontSize: 12 }}>{l}</td>
                        <td style={{ padding: '5px 0', color: DARK, fontWeight: 600 }}>{v as string}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.items?.length > 0 && (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Items</div>
                    {detail.items.map((it: any, i: number) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f4f4f8', fontSize: 13 }}>
                        <span style={{ color: '#444' }}>{it.name || it.mealPackageName}{it.quantity > 1 ? ` ×${it.quantity}` : ''}</span>
                        <span style={{ fontWeight: 600 }}>{fmtMoney(it.price || it.total || 0)}</span>
                      </div>
                    ))}
                  </>
                )}
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: '#888' }}>Total</span>
                  <strong style={{ color: DARK }}>{fmtMoney(detail.total || detail.totalAmount || 0)}</strong>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.type === 'success' ? '#1D9E75' : '#E24B4A', color: '#fff', padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', fontFamily: F }}>
          {toast.msg}
        </div>
      )}
    </>
  )
}
