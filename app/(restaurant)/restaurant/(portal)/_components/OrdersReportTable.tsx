'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { OrderDrawer, statusDotColor, statusLabel } from '../orders/page'
import { formatTime12 } from '../../../../../lib/utils/time'

// The Reporting page's on-screen orders report.
//
// Rows come from /api/restaurant/reports/rows, which runs the SAME loader as the
// CSV / Excel / PDF downloads (lib/reports/order-report-load.ts): same scope,
// same rows, same visible columns, same "TOTAL (paid orders)" row. Nothing is
// recomputed here — this file only formats, sorts and opens orders.

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

interface Col { key: string; label: string; financial: boolean }
type Row = Record<string, unknown> & { orderId: string; orderReference?: string; paid?: boolean; orderStatus: string; paymentStatus: string; refundAmount: number }
interface Report { columns: Col[]; rows: Row[]; totals: Record<string, number>; totalsLabel: string }

const money = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n) : ''
}
// YYYY-MM-DD shown as "Nov 3, 2026" without a timezone round-trip (the value is
// already a calendar date; parsing it as an instant would shift it a day).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtYmd(s: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''))
  if (!m) return String(s ?? '')
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
}

// Payment wording comes from lib/order/stripe-facts.ts paymentLabel.
function paymentColor(p: string): string {
  switch (p) {
    case 'Paid': return '#1D9E75'
    case 'Refunded':
    case 'Partially refunded': return '#F59E0B'
    case 'Unpaid invoice': return '#5B6FE8'
    case 'Declined': return '#E53935'
    default: return '#6B7280'
  }
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999,
      background: `${color}1A`, color, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {children}
    </span>
  )
}

export default function OrdersReportTable({ from, to, dateField }: { from: string; to: string; dateField: 'order' | 'created' }) {
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [drawerRef, setDrawerRef] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!from || !to) return
    const ac = new AbortController()
    setLoading(true); setError('')
    const qs = new URLSearchParams({ from, to, dateField })
    fetch(`/api/restaurant/reports/rows?${qs}`, { signal: ac.signal })
      .then(async r => {
        const d = await r.json().catch(() => null)
        if (!r.ok) { setReport(null); setError([d?.error, d?.description].filter(Boolean).join(' ') || `Could not load orders (HTTP ${r.status}).`); return }
        setReport(d as Report)
      })
      .catch(e => { if (e?.name !== 'AbortError') { setReport(null); setError('Could not load orders.') } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [from, to, dateField, reloadTick])

  const cols = report?.columns ?? []
  const firstText = cols.findIndex(c => !c.financial)

  const rows = useMemo(() => {
    const list = report?.rows ?? []
    if (!sort) return list
    const col = cols.find(c => c.key === sort.key)
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (r: Row) => r[sort.key]
    return [...list].sort((a, b) => {
      const va = val(a), vb = val(b)
      if (col?.financial) return (Number(va) - Number(vb)) * dir
      const sa = String(va ?? ''), sb = String(vb ?? '')
      // Order numbers are numeric strings: compare them as numbers.
      if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) return (Number(sa) - Number(sb)) * dir
      // Order date sorts with its time, so a day's orders keep their sequence.
      if (sort.key === 'orderDate') {
        const ka = `${sa} ${String(a.orderTime ?? '')}`, kb = `${sb} ${String(b.orderTime ?? '')}`
        return ka.localeCompare(kb) * dir
      }
      return sa.localeCompare(sb) * dir
    })
  }, [report, sort, cols])

  const onSort = useCallback((key: string) => {
    setSort(s => !s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null)
  }, [])

  const cell = (r: Row, c: Col): React.ReactNode => {
    const v = r[c.key]
    if (c.financial) return money(v)
    switch (c.key) {
      case 'orderId': return <span style={{ fontWeight: 600, color: DARK }}>#{String(v ?? '')}</span>
      case 'createdDate':
      case 'orderDate': return fmtYmd(v)
      case 'orderTime': return formatTime12(String(v ?? ''))
      case 'orderStatus': {
        if (!r.orderStatus) return '—'
        const o = { orderStatus: r.orderStatus, refund: Number(r.refundAmount) || 0, total: Number(r.gross) || 0 }
        return <Badge color={statusDotColor(o)}>{statusLabel(o)}</Badge>
      }
      case 'paymentStatus': return r.paymentStatus ? <Badge color={paymentColor(r.paymentStatus)}>{r.paymentStatus}</Badge> : <span style={{ color: '#bbb' }}>—</span>
      default: return v == null || v === '' ? '—' : String(v)
    }
  }

  const th: React.CSSProperties = {
    padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase',
    cursor: 'pointer', whiteSpace: 'nowrap', background: '#F7F8FC', position: 'sticky', top: 0, zIndex: 1,
    borderBottom: '1px solid #eee', userSelect: 'none',
  }
  const td: React.CSSProperties = { padding: '10px 12px', fontSize: 13, color: '#555', whiteSpace: 'nowrap', borderTop: '1px solid #f5f5f5' }
  const unpaidCount = (report?.rows ?? []).filter(r => r.paid === false).length

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', margin: '18px 0 8px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>
          {loading ? 'Loading orders…' : report ? `${report.rows.length.toLocaleString()} order${report.rows.length === 1 ? '' : 's'}` : ''}
        </div>
        {!loading && unpaidCount > 0 && (
          <div style={{ fontSize: 11.5, color: '#999' }}>Unpaid orders are listed (greyed) but not included in the total.</div>
        )}
      </div>
      {/* The table scrolls inside this box — never the page — at any width. */}
      <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'auto', maxHeight: 620, maxWidth: '100%', background: '#fff' }}>
        {error ? (
          <div style={{ padding: 28, textAlign: 'center', color: '#E53935', fontSize: 13 }}>{error}</div>
        ) : loading && !report ? (
          <div style={{ padding: 16 }}>
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="rep-skel" style={{ height: 14, borderRadius: 6, margin: '10px 0' }} />)}
          </div>
        ) : report && report.rows.length === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: '#aaa', fontSize: 13 }}>No orders in this date range.</div>
        ) : report && (
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, opacity: loading ? 0.5 : 1 }}>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.key} onClick={() => onSort(c.key)} style={{ ...th, textAlign: c.financial ? 'right' : 'left' }}
                    aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    {c.label}{' '}<span style={{ color: sort?.key === c.key ? '#5B6FE8' : '#ccc' }}>{sort?.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const unpaid = r.paid === false
                const ref = r.orderReference || ''
                return (
                  <tr key={ref || `${r.orderId}-${i}`}
                    onClick={() => { if (ref) setDrawerRef(ref) }}
                    className="rep-row"
                    style={{ cursor: ref ? 'pointer' : 'default', opacity: unpaid ? 0.55 : 1 }}
                    title={unpaid ? 'Not paid — not included in the total' : undefined}>
                    {cols.map(c => (
                      <td key={c.key} style={{ ...td, textAlign: c.financial ? 'right' : 'left', fontVariantNumeric: c.financial ? 'tabular-nums' : undefined, color: c.key === 'totalDistributed' ? DARK : td.color, fontWeight: c.key === 'totalDistributed' ? 600 : undefined, ...(c.key === 'location' ? { whiteSpace: 'normal', minWidth: 150, maxWidth: 200 } : null) }}>
                        {cell(r, c)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                {cols.map((c, i) => (
                  <td key={c.key} style={{
                    ...td, position: 'sticky', bottom: 0, background: '#F7F7FB', borderTop: '1.5px solid #e6e6ee',
                    fontWeight: 700, color: DARK, textAlign: c.financial ? 'right' : 'left', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {i === firstText ? report.totalsLabel : c.financial ? money(report.totals[c.key] ?? 0) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      <style>{`.rep-row:hover td { background: #FAFAFE; }`}</style>

      {drawerRef && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 199 }} onClick={() => setDrawerRef(null)} />
          <OrderDrawer orderRef={drawerRef} onClose={() => setDrawerRef(null)} onOrderUpdated={() => setReloadTick(t => t + 1)} />
        </>
      )}
    </div>
  )
}
