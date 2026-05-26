'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface Location {
  reference: string
  businessName: string
  businessNameWithoutSpaces?: string
  address?: { addressLine1?: string; city?: string; state?: string; zipcode?: string }
  createdDate?: string
  blocked?: boolean
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return `${(dt.getMonth() + 1).toString().padStart(2, '0')}/${dt.getDate().toString().padStart(2, '0')}/${dt.getFullYear()}`
  } catch { return d }
}

function fmtAddress(a?: Location['address']) {
  if (!a) return ''
  const parts = [a.addressLine1, a.city, a.state, a.zipcode].filter(Boolean)
  return parts.join(', ')
}

export default function LocationsPage() {
  const router = useRouter()
  const [locations, setLocations] = useState<Location[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
      if (search) params.set('search', search)
      const res = await fetch(`/api/restaurant/locations?${params}`)
      if (!res.ok) {
        setError('Failed to load locations')
        setLocations([])
      } else {
        const data = await res.json()
        setLocations(data.content || [])
        setTotal(data.totalElements || 0)
      }
    } catch {
      setError('Unable to reach server')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search])

  useEffect(() => { load() }, [load])

  async function toggleBlock(loc: Location) {
    const newBlocked = !loc.blocked
    await fetch(`/api/restaurant/locations/${loc.reference}/block?blocked=${newBlocked}`, { method: 'PUT' })
    setLocations(prev => prev.map(l => l.reference === loc.reference ? { ...l, blocked: newBlocked } : l))
  }

  async function cloneLocation(ref: string) {
    if (!confirm('Clone this location?')) return
    await fetch(`/api/restaurant/locations/${ref}/clone`, { method: 'POST' })
    load()
  }

  async function deleteLocation(ref: string) {
    if (!confirm('Delete this location? This cannot be undone.')) return
    await fetch(`/api/restaurant/locations/${ref}`, { method: 'DELETE' })
    load()
  }

  async function switchToLocation(loc: Location) {
    setSwitching(loc.reference)
    try {
      const res = await fetch(`/api/restaurant/selected-restaurant?restaurantReference=${loc.reference}`, { method: 'PUT' })
      if (res.ok) {
        try { localStorage.setItem('selectedRestaurant', loc.reference) } catch {}
        router.push('/restaurant/dashboard')
      }
    } finally {
      setSwitching(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
  const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Locations</h1>
      <p style={{ fontSize: 13, color: '#666', margin: '0 0 20px' }}>Restaurants you manage. Click a location to switch to its portal.</p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by name…"
          value={search}
          onChange={e => { setPage(0); setSearch(e.target.value) }}
          style={{ flex: '0 0 280px', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }}
        />
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#666' }}>{total} location{total === 1 ? '' : 's'}</div>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...colHead, width: 70 }}>Active</th>
            <th style={colHead}>Business Name</th>
            <th style={colHead}>Address</th>
            <th style={{ ...colHead, width: 110 }}>Created</th>
            <th style={{ ...colHead, width: 180 }}>Checkout Link</th>
            <th style={{ ...colHead, width: 220, textAlign: 'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !locations.length && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>No locations.</td></tr>}
            {!loading && locations.map(loc => {
              const slug = loc.businessNameWithoutSpaces || ''
              const link = slug ? `https://www.familymeal.com/disco/${slug}/catering` : ''
              return (
                <tr key={loc.reference}>
                  <td style={cell}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!loc.blocked}
                        onChange={() => toggleBlock(loc)}
                        style={{ accentColor: BLUE, cursor: 'pointer' }}
                      />
                    </label>
                  </td>
                  <td style={cell}>
                    <button
                      onClick={() => switchToLocation(loc)}
                      disabled={switching === loc.reference}
                      style={{ background: 'none', border: 'none', color: BLUE, fontWeight: 600, cursor: 'pointer', fontSize: 13, padding: 0, textAlign: 'left', fontFamily: F }}
                    >
                      {loc.businessName}
                      {switching === loc.reference && <span style={{ marginLeft: 6, color: '#aaa', fontWeight: 400 }}>switching…</span>}
                    </button>
                  </td>
                  <td style={{ ...cell, color: '#555' }}>{fmtAddress(loc.address)}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(loc.createdDate)}</td>
                  <td style={cell}>
                    {link ? (
                      <a href={link} target="_blank" rel="noreferrer" style={{ color: BLUE, textDecoration: 'none', fontSize: 12, wordBreak: 'break-all' }}>
                        {slug}
                      </a>
                    ) : <span style={{ color: '#bbb' }}>—</span>}
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <button onClick={() => cloneLocation(loc.reference)} style={btnLink}>Clone</button>
                    <button onClick={() => switchToLocation(loc)} style={{ ...btnLink, color: BLUE }}>Open</button>
                    <button onClick={() => deleteLocation(loc.reference)} style={{ ...btnLink, color: '#E76F51' }}>Delete</button>
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
          <select
            value={pageSize}
            onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }}
            style={{ border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }}
          >
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
      </div>
    </div>
  )
}

const btnLink: React.CSSProperties = {
  background: 'none', border: 'none', color: '#666', cursor: 'pointer',
  fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4,
}
const pageBtn: React.CSSProperties = {
  background: '#fff', border: '1px solid #ddd', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK,
}
