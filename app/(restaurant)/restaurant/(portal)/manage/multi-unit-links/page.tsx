'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface MultiLink {
  reference: string
  url: string
  header?: string
  numberOfLocations?: number
  locationImage?: string
  locationRedirection?: string
}

const REDIRECTION_OPTIONS = ['LOCATION_PICKER', 'DIRECT_TO_RESTAURANT', 'CUSTOM']

export default function MultiUnitLinksPage() {
  const [links, setLinks] = useState<MultiLink[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<MultiLink> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
    const res = await fetch(`/api/restaurant/multi-unit-links?${params}`)
    if (res.ok) {
      const data = await res.json()
      setLinks(data.content || [])
      setTotal(data.totalElements || 0)
    } else {
      setLinks([])
    }
    setLoading(false)
  }, [page, pageSize])

  useEffect(() => { load() }, [load])

  async function saveLink() {
    if (!editing) return
    const isNew = !editing.reference
    const url = isNew ? '/api/restaurant/multi-unit-links' : `/api/restaurant/multi-unit-links/${editing.reference}`
    await fetch(url, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editing),
    })
    setEditing(null)
    load()
  }

  async function deleteLink(ref: string) {
    if (!confirm('Delete this link?')) return
    await fetch(`/api/restaurant/multi-unit-links/${ref}`, { method: 'DELETE' })
    load()
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
  const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Links</h1>
        <button onClick={() => setEditing({ url: '', header: '', numberOfLocations: 0, locationRedirection: 'LOCATION_PICKER' })}
          style={{ padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
          + Add Link
        </button>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={colHead}>URL</th>
            <th style={colHead}>Header</th>
            <th style={{ ...colHead, width: 110, textAlign: 'right' }}># Locations</th>
            <th style={{ ...colHead, width: 160 }}>Redirection</th>
            <th style={{ ...colHead, width: 160, textAlign: 'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !links.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>No links yet.</td></tr>}
            {!loading && links.map(l => (
              <tr key={l.reference}>
                <td style={cell}><a href={l.url} target="_blank" rel="noreferrer" style={{ color: BLUE, textDecoration: 'none' }}>{l.url}</a></td>
                <td style={{ ...cell, color: '#555' }}>{l.header}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{l.numberOfLocations ?? 0}</td>
                <td style={{ ...cell, color: '#666' }}>{l.locationRedirection || '—'}</td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  <button onClick={() => setEditing(l)} style={btnLink}>Edit</button>
                  <button onClick={() => deleteLink(l.reference)} style={{ ...btnLink, color: '#E76F51' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }}
            style={{ border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
      </div>

      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 480, width: '90%', fontFamily: F }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: DARK }}>{editing.reference ? 'Edit Link' : 'New Link'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={lbl}>URL</label>
                <input style={input} value={editing.url || ''} onChange={e => setEditing({ ...editing, url: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>Header</label>
                <input style={input} value={editing.header || ''} onChange={e => setEditing({ ...editing, header: e.target.value })} />
              </div>
              <div>
                <label style={lbl}># of Locations</label>
                <input type="number" style={input} value={editing.numberOfLocations ?? 0} onChange={e => setEditing({ ...editing, numberOfLocations: Number(e.target.value) })} />
              </div>
              <div>
                <label style={lbl}>Location Redirection</label>
                <select style={input} value={editing.locationRedirection || ''} onChange={e => setEditing({ ...editing, locationRedirection: e.target.value })}>
                  {REDIRECTION_OPTIONS.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={() => setEditing(null)} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }}>Cancel</button>
              <button onClick={saveLink} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const btnLink: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5 }
