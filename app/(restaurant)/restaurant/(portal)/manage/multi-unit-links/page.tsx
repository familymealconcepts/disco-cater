'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const INDIGO = '#5B6FE8'
const PAGE_BG = '#F7F8FC'
const FM_IMG_BASE = 'https://api.familymeal.com/public-api/images'

// Where the shareable links resolve — the Disco Cater multi-unit
// /locations/{slug} page.
const DISCO_BASE = 'https://www.discocater.com/locations/'

// FM's link object — fields observed on /api/system-admin/restaurants/links.
// `urlFrom: 'Dashboard'` is the "this is the restaurant's own dashboard
// link" indicator FM uses to hide Delete on the auto-managed row.
interface MultiLink {
  reference: string
  url: string                            // slug, no domain
  header?: string                        // display title
  numberOfLocations?: number
  restaurantReferences?: string[]        // associated location refs
  locationImage?: string                 // image reference (FM image CDN)
  image?: { reference?: string }
  urlFrom?: string                       // 'Dashboard' | 'Links' | undefined
}

interface LocationOption {
  reference: string
  businessName: string
}

function imageUrl(l: MultiLink): string | null {
  const ref = l.image?.reference || l.locationImage
  if (!ref) return null
  if (ref.startsWith('http')) return ref
  return `${FM_IMG_BASE}/${ref}/download?size=80`
}

export default function MultiUnitLinksPage() {
  const [links, setLinks] = useState<MultiLink[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<MultiLink> | null>(null)
  const [saving, setSaving] = useState(false)
  const [locations, setLocations] = useState<LocationOption[]>([])
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
    try {
      const res = await fetch(`/api/restaurant/multi-unit-links?${params}`)
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        setError(d?.error || `Failed to load links (HTTP ${res.status})`)
        setLinks([]); setTotal(0)
      } else {
        const data = await res.json()
        // FM's /links/listing returns either a paginated envelope or a
        // plain array depending on the deployment — handle both.
        if (Array.isArray(data)) {
          setLinks(data); setTotal(data.length)
        } else {
          setLinks(data.content || data.data || [])
          setTotal(data.totalElements ?? data.total ?? (data.content?.length || 0))
        }
      }
    } catch {
      setError('Unable to reach server')
      setLinks([]); setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize])

  useEffect(() => { load() }, [load])

  // Load all locations once for the multi-select picker in the dialog.
  useEffect(() => {
    fetch('/api/restaurant/locations?size=1000')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.content) {
          setLocations(d.content.map((l: { reference: string; businessName: string }) => ({
            reference: l.reference, businessName: l.businessName,
          })))
        }
      })
      .catch(() => {})
  }, [])

  async function saveLink() {
    if (!editing || !editing.url || !editing.header) return
    setSaving(true)
    const isNew = !editing.reference
    const url = isNew ? '/api/restaurant/multi-unit-links' : `/api/restaurant/multi-unit-links/${editing.reference}`
    const body = {
      ...editing,
      restaurantReferences: editing.restaurantReferences || [],
      numberOfLocations: (editing.restaurantReferences || []).length,
    }
    try {
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        setError(d?.error || `Save failed (HTTP ${res.status})`)
      } else {
        setEditing(null)
        load()
      }
    } finally { setSaving(false) }
  }

  async function deleteLink(l: MultiLink) {
    if (l.urlFrom === 'Dashboard') return
    if (!confirm(`Delete the link "${l.header || l.url}"? This cannot be undone.`)) return
    await fetch(`/api/restaurant/multi-unit-links/${l.reference}`, { method: 'DELETE' })
    load()
  }

  function toggleLocation(ref: string) {
    if (!editing) return
    const cur = editing.restaurantReferences || []
    const next = cur.includes(ref) ? cur.filter(r => r !== ref) : [...cur, ref]
    setEditing({ ...editing, restaurantReferences: next, numberOfLocations: next.length })
  }

  function copy(text: string, id: string) {
    try {
      navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(c => (c === id ? null : c)), 1500)
    } catch {}
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: PAGE_BG, borderBottom: '1px solid #f0f0f0', letterSpacing: '0.04em' }
  const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Links</h1>
          <p style={{ fontSize: 12, color: '#777', margin: '4px 0 0', lineHeight: 1.5, maxWidth: 600 }}>
            Shareable URLs that route customers to one or more of your locations.
            Share the Disco Cater URL with your customers.
          </p>
        </div>
        <button onClick={() => setEditing({ url: '', header: '', restaurantReferences: [] })}
          style={{ padding: '10px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
          + Add Link
        </button>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, margin: '14px 0', fontSize: 13 }}>{error}</div>}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden', marginTop: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...colHead, width: 80 }}>Image</th>
            <th style={colHead}>URL</th>
            <th style={colHead}>Title</th>
            <th style={{ ...colHead, width: 110, textAlign: 'right' }}># Locations</th>
            <th style={{ ...colHead, width: 60, textAlign: 'center' }}>Open</th>
            <th style={{ ...colHead, width: 140, textAlign: 'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999', padding: '32px 14px' }}>Loading…</td></tr>}
            {!loading && !links.length && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999', padding: '32px 14px' }}>No links yet.</td></tr>}
            {!loading && links.map(l => {
              const img = imageUrl(l)
              const discoUrl = `${DISCO_BASE}${l.url}`
              const protectedRow = l.urlFrom === 'Dashboard'
              return (
                <tr key={l.reference}>
                  <td style={cell}>
                    {img ? (
                      <img src={img} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', border: '1px solid #eee' }} />
                    ) : (
                      <div style={{ width: 44, height: 44, background: '#f0f0f4', borderRadius: 8, border: '1px solid #eee' }} />
                    )}
                  </td>
                  <td style={cell}>
                    {/* Primary: Disco Cater */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <a href={discoUrl} target="_blank" rel="noreferrer"
                        style={{ color: INDIGO, textDecoration: 'none', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}
                        title={discoUrl}>
                        {discoUrl}
                      </a>
                      <button onClick={() => copy(discoUrl, `disco-${l.reference}`)} title="Copy"
                        style={iconBtn}>
                        {copied === `disco-${l.reference}` ? '✓' : '⧉'}
                      </button>
                    </div>
                  </td>
                  <td style={{ ...cell, color: '#444' }}>
                    {l.header || '—'}
                    {protectedRow && (
                      <span style={{ marginLeft: 6, fontSize: 10, padding: '2px 6px', borderRadius: 10, background: '#EEF0FD', color: INDIGO, fontWeight: 700 }}>Dashboard</span>
                    )}
                  </td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{l.numberOfLocations ?? l.restaurantReferences?.length ?? 0}</td>
                  <td style={{ ...cell, textAlign: 'center' }}>
                    <a href={discoUrl} target="_blank" rel="noreferrer" title="Open" style={{ color: INDIGO, textDecoration: 'none', fontSize: 16 }}>↗</a>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => setEditing(l)} style={btnLink}>Edit</button>
                    {!protectedRow && (
                      <button onClick={() => deleteLink(l)} style={{ ...btnLink, color: '#E76F51' }}>Delete</button>
                    )}
                  </td>
                </tr>
              )
            })}
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => !saving && setEditing(null)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 560, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: F }}>
            <h3 style={{ margin: '0 0 18px', fontSize: 17, fontWeight: 700, color: DARK }}>
              {editing.reference ? 'Edit Link' : 'New Link'}
            </h3>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 4 }}>
              <div>
                <label style={lbl}>Title</label>
                <input style={input} value={editing.header || ''} placeholder="Group name shown on the locations page"
                  onChange={e => setEditing({ ...editing, header: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>URL slug</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>{DISCO_BASE}</span>
                  <input style={input} value={editing.url || ''} placeholder="my-group"
                    onChange={e => setEditing({ ...editing, url: e.target.value.replace(/^\/+/, '') })} />
                </div>
              </div>
              <div>
                <label style={lbl}>Locations ({(editing.restaurantReferences || []).length})</label>
                <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, maxHeight: 220, overflowY: 'auto', padding: 4 }}>
                  {locations.length === 0 && (
                    <div style={{ padding: 14, fontSize: 12, color: '#999' }}>No locations loaded.</div>
                  )}
                  {locations.map(loc => {
                    const checked = (editing.restaurantReferences || []).includes(loc.reference)
                    return (
                      <label key={loc.reference}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: DARK, background: checked ? '#EEF0FD' : 'transparent' }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleLocation(loc.reference)} style={{ accentColor: INDIGO }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc.businessName}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={() => setEditing(null)} disabled={saving}
                style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }}>
                Cancel
              </button>
              <button onClick={saveLink} disabled={saving || !editing.url || !editing.header}
                style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: (saving || !editing.url || !editing.header) ? 0.6 : 1 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const btnLink: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4, fontWeight: 600 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }
const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: INDIGO, padding: '2px 4px', fontFamily: F }
