'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const PAGE_SIZE = 10

interface OrderItem {
  reference?: string
  id?: string
  restaurantName?: string
  restaurant?: { name?: string }
  orderDate?: string
  createdAt?: string
  date?: string
  total?: number
  totalAmount?: number
  status?: string
}

interface OrderDetail extends OrderItem {
  deliveryAddress?: { addressLine1?: string } | string
  items?: { name?: string; mealPackageName?: string; price?: number; total?: number }[]
}

function fmtDate(d?: string) {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return d }
}
function fmtMoney(n?: number) { return `$${(n || 0).toFixed(2)}` }

export default function HistoryPage() {
  const [orders, setOrders] = useState<OrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<OrderDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

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
    setSelected({})
    try {
      const res = await fetch(`/api/fm-order-detail/${ref}`, { credentials: 'include' })
      if (res.ok) setSelected(await res.json())
    } catch {}
    setDetailLoading(false)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div style={{ fontFamily: F }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 24, marginTop: 0 }}>Order History</h1>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading orders…</div>
      ) : orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🪩</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 6 }}>No orders yet</div>
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 22 }}>Start exploring catering options</div>
          <Link href="/fullmap" style={{ padding: '10px 24px', background: BLUE, color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
            Browse restaurants
          </Link>
        </div>
      ) : (
        <>
          <div style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', marginBottom: 16, background: '#fff' }}>
            {orders.map((o, i) => (
              <div
                key={o.reference || o.id || i}
                onClick={() => openDetail((o.reference || o.id) as string)}
                style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: i < orders.length - 1 ? '1px solid #f0f0f0' : 'none', cursor: 'pointer', gap: 14, transition: 'background 0.1s' }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#fafafa'}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = ''}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{o.restaurantName || o.restaurant?.name || 'Order'}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{fmtDate(o.orderDate || o.createdAt || o.date)}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtMoney(o.total || o.totalAmount)}</div>
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
              <span style={{ fontSize: 12, color: '#888' }}>{page + 1} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #e0e0e0', background: '#fff', color: page >= totalPages - 1 ? '#ccc' : '#555', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, fontFamily: F }}>
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {/* Order detail modal */}
      {selected !== null && (
        <>
          <div onClick={() => setSelected(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 700 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto', zIndex: 701, boxShadow: '0 16px 48px rgba(0,0,0,0.18)', fontFamily: F }}>
            <button onClick={() => setSelected(null)} style={{ position: 'absolute', top: 14, right: 14, background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%', fontSize: 16, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
            {detailLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#888' }}>Loading…</div>
            ) : (
              <>
                <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 16 }}>Order details</div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <tbody>
                    {[
                      ['Restaurant', selected.restaurantName || selected.restaurant?.name || '—'],
                      ['Date', fmtDate(selected.orderDate || selected.createdAt)],
                      ['Status', selected.status || '—'],
                      ['Total', fmtMoney(selected.total || selected.totalAmount)],
                      ['Delivery address', typeof selected.deliveryAddress === 'string' ? selected.deliveryAddress : selected.deliveryAddress?.addressLine1 || '—'],
                    ].map(([l, v]) => (
                      <tr key={l}><td style={{ padding: '6px 0', color: '#888', verticalAlign: 'top', width: '40%' }}>{l}</td><td style={{ padding: '6px 0', color: DARK, fontWeight: 600 }}>{v as string}</td></tr>
                    ))}
                  </tbody>
                </table>
                {selected?.items && selected.items.length > 0 && (
                  <>
                    <div style={{ height: 1, background: '#f0f0f0', margin: '12px 0' }} />
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Items</div>
                    {selected.items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}>
                        <span style={{ color: '#444' }}>{item.name || item.mealPackageName}</span>
                        <span style={{ color: DARK, fontWeight: 600 }}>{fmtMoney(item.price || item.total)}</span>
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
