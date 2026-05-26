'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface ScrapedLocation {
  id: string
  location?: string
  city?: string
  state?: string
  total_restaurant_count?: number
  comp_restaurant_count?: number
  err_restaurant_count?: number
  created_at?: string
  status?: string
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return d }
}

function statusPill(s?: string): React.CSSProperties {
  const upper = (s || '').toUpperCase()
  const colors =
    upper === 'COMPLETED' ? { bg: '#E8F5E9', fg: '#2E7D32' }
    : upper === 'INPROGRESS' || upper === 'IN_PROGRESS' ? { bg: '#FFF8E1', fg: '#B07000' }
    : upper === 'ERRORED' || upper === 'ERROR' ? { bg: '#FFF0F0', fg: '#C62828' }
    : { bg: '#F3F4F6', fg: '#555' }
  return {
    display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 11,
    fontWeight: 600, background: colors.bg, color: colors.fg,
  }
}

export default function BulkImportMenuPage() {
  const [rows, setRows] = useState<ScrapedLocation[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(pageSize))
    const res = await fetch(`/api/admin/bulk-import/locations?${params}`)
    if (!res.ok) {
      const d = await res.json().catch(() => null)
      setError(d?.error || 'Failed to load locations')
      setRows([]); setTotal(0)
    } else {
      const d = await res.json()
      // Service may return either {content,totalElements} or raw array
      const arr: ScrapedLocation[] = Array.isArray(d) ? d : (d.content || d.data || [])
      const t = Array.isArray(d) ? d.length : (d.totalElements ?? d.total ?? arr.length)
      setRows(arr)
      setTotal(t)
    }
    setLoading(false)
  }, [page, pageSize])

  useEffect(() => { load() }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Bulk Menu Import</h1>
          <p style={{ fontSize: 12, color: '#888', margin: '4px 0 0' }}>External menuupload service · {process.env.NEXT_PUBLIC_MENUUPLOAD_DOMAIN || 'menuuploadstg.familymeal.com'}</p>
        </div>
        <button onClick={() => setShowCreate(true)} style={primaryBtn}>+ New Bulk Import</button>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Location</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Total</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Completed</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Errors</th>
              <th style={colHead}>Created</th>
              <th style={colHead}>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>No bulk imports yet.</td></tr>}
            {!loading && rows.map(r => {
              const label = r.location || [r.city, r.state].filter(Boolean).join(', ') || r.id
              const safeId = encodeURIComponent(Buffer.from(r.id, 'utf8').toString('base64'))
              return (
                <tr key={r.id}>
                  <td style={{ ...cell, fontWeight: 500 }}>
                    <Link href={`/admin/manage-restaurants/bulk-import-menu/${safeId}`} style={{ color: BLUE, textDecoration: 'none' }}>
                      {label}
                    </Link>
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>{r.total_restaurant_count ?? 0}</td>
                  <td style={{ ...cell, textAlign: 'right', color: '#2E7D32', fontWeight: 600 }}>{r.comp_restaurant_count ?? 0}</td>
                  <td style={{ ...cell, textAlign: 'right', color: (r.err_restaurant_count ?? 0) > 0 ? '#C62828' : '#888', fontWeight: 600 }}>{r.err_restaurant_count ?? 0}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(r.created_at)}</td>
                  <td style={cell}><span style={statusPill(r.status)}>{r.status}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{total} location{total === 1 ? '' : 's'}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }} style={smallSelect}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {showCreate && <CreateBulkImportDialog onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); setPage(0); load() }} />}

      <style>{`select:focus, input:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; }`}</style>
    </div>
  )
}

function CreateBulkImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  // Minimal address-based create. FM extracts city/state/country/timezone via
  // Google Places autocomplete; we keep this simple — the user pastes the
  // address and we send what we have. The menuupload backend tolerates partial
  // address data per FM source.
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [country, setCountry] = useState('USA')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!city || !state) { setError('City and state required'); return }
    setSaving(true); setError('')
    const res = await fetch('/api/admin/bulk-import/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city, state, country }),
    })
    setSaving(false)
    if (res.ok) onSaved()
    else {
      const d = await res.json().catch(() => ({}))
      setError(d?.error || 'Failed to start import')
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 460, width: '100%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: DARK }}>Start a Bulk Import</h3>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 14px' }}>
          The menuupload service will scrape catering restaurants in this location and create import jobs.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div>
              <label style={lbl}>City*</label>
              <input style={inputSt} value={city} onChange={e => setCity(e.target.value)} placeholder="Nashville" />
            </div>
            <div>
              <label style={lbl}>State*</label>
              <input style={inputSt} value={state} onChange={e => setState(e.target.value.toUpperCase())} maxLength={2} placeholder="TN" />
            </div>
          </div>
          <div>
            <label style={lbl}>Country</label>
            <input style={inputSt} value={country} onChange={e => setCountry(e.target.value)} />
          </div>
        </div>
        {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginTop: 12, fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button onClick={onClose} disabled={saving} style={secondaryBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primaryBtn}>{saving ? 'Starting…' : 'Start import'}</button>
        </div>
      </div>
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: '#6B6EF9', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
const secondaryBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }
