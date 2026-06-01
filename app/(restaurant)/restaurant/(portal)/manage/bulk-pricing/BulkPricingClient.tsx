'use client'
import { useState, useEffect, useCallback } from 'react'
import { useSelectedRestaurant } from '../../_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const fmtMoney = (n: number | null) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—')

interface Row {
  key: string
  restaurantRef: string
  restaurantName: string
  pkgRef: string
  name: string
  currentPrice: number | null
  currentDisplayPrice: string | null
  newPrice: string
  newDisplayPrice: string
  checked: boolean
  status: 'idle' | 'pending' | 'ok' | 'error'
  error?: string
}
interface Group { restaurantRef: string; restaurantName: string; rows: Row[] }
interface SearchResp {
  query: string
  totalLocations: number
  matchedLocations: number
  matches: { restaurantRef: string; restaurantName: string; items: { pkgRef: string; name: string; price: number | null; displayPrice: string | null; serves: string | null }[] }[]
}

export default function BulkPricingClient() {
  const { ref: selectedRef, name: selectedName, setRestaurant } = useSelectedRestaurant()

  const [locationCount, setLocationCount] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [resp, setResp] = useState<SearchResp | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [applying, setApplying] = useState(false)
  const [summary, setSummary] = useState<{ ok: number; fail: number; failedLocs: string[] } | null>(null)

  // Location count up front, so the search spinner can say "Searching X locations…".
  useEffect(() => {
    fetch('/api/restaurant/system-admin-restaurants')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d)) setLocationCount(d.length) })
      .catch(() => {})
  }, [])

  const flatRows = useCallback(() => groups.flatMap(g => g.rows), [groups])

  function updateRow(key: string, patch: Partial<Row>) {
    setGroups(gs => gs.map(g => ({ ...g, rows: g.rows.map(r => (r.key === key ? { ...r, ...patch } : r)) })))
  }

  async function runSearch() {
    const q = query.trim()
    if (!q) return
    setSearching(true); setSearchError(''); setResp(null); setGroups([]); setSummary(null)
    try {
      const res = await fetch(`/api/restaurant/bulk-pricing/search?name=${encodeURIComponent(q)}`)
      const d = await res.json()
      if (!res.ok) { setSearchError(d?.error || `Search failed (HTTP ${res.status})`); return }
      const data = d as SearchResp
      setResp(data)
      setGroups(data.matches.map(m => ({
        restaurantRef: m.restaurantRef,
        restaurantName: m.restaurantName,
        rows: m.items.map(it => ({
          key: `${m.restaurantRef}:${it.pkgRef}`,
          restaurantRef: m.restaurantRef,
          restaurantName: m.restaurantName,
          pkgRef: it.pkgRef,
          name: it.name,
          currentPrice: it.price,
          currentDisplayPrice: it.displayPrice,
          newPrice: it.price != null ? String(it.price) : '',
          newDisplayPrice: it.displayPrice || '',
          checked: true,
          status: 'idle' as const,
        })),
      })))
    } catch {
      setSearchError('Unable to reach the server.')
    } finally {
      setSearching(false)
    }
  }

  async function apply(onlyFailed: boolean) {
    const targets = flatRows().filter(r => r.checked && (!onlyFailed || r.status === 'error'))
    if (targets.length === 0) return
    setApplying(true); setSummary(null)
    let ok = 0, fail = 0
    const failedLocs: string[] = []
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i]
      updateRow(r.key, { status: 'pending', error: undefined })
      try {
        const res = await fetch('/api/restaurant/bulk-pricing/apply-one', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pkgRef: r.pkgRef, restaurantRef: r.restaurantRef, price: parseFloat(r.newPrice), displayPrice: r.newDisplayPrice.trim() || null }),
        })
        const d = await res.json().catch(() => ({ ok: false, error: 'Bad response' }))
        if (res.ok && d.ok) { updateRow(r.key, { status: 'ok' }); ok++ }
        else { updateRow(r.key, { status: 'error', error: d.error || `HTTP ${res.status}` }); fail++; failedLocs.push(r.restaurantName) }
      } catch {
        updateRow(r.key, { status: 'error', error: 'Network error' }); fail++; failedLocs.push(r.restaurantName)
      }
      if (i < targets.length - 1) await sleep(500) // FM rate sensitivity
    }
    setSummary({ ok, fail, failedLocs })
    // apply-one moved FM's "current restaurant" per location — re-sync it to the
    // admin's actual selection so the rest of the portal stays consistent.
    try { if (selectedRef) await setRestaurant(selectedRef, selectedName || undefined) } catch {}
    setApplying(false)
  }

  const checkedCount = flatRows().filter(r => r.checked).length
  const failedCount = flatRows().filter(r => r.status === 'error').length

  // ── styles ──
  const card: React.CSSProperties = { background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: 20, marginBottom: 18 }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 11px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }
  const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '8px 10px', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: DARK, borderTop: '1px solid #f3f3f3', verticalAlign: 'middle' }
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F })

  const statusIcon = (s: Row['status']) => s === 'ok' ? <span style={{ color: '#2E7D32', fontWeight: 700 }}>✓</span>
    : s === 'error' ? <span style={{ color: '#C0392B', fontWeight: 700 }}>✗</span>
    : s === 'pending' ? <span style={{ color: BLUE }}>⟳</span> : <span style={{ color: '#ccc' }}>·</span>

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 1000 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');`}</style>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Bulk Pricing</h1>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 22px' }}>
        Find a menu item by name across all your locations and update its price everywhere.
      </p>

      {/* Step 1 — Search */}
      <div style={card}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 6 }}>Search menu item by name</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            style={{ ...input, flex: 1 }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
            placeholder="e.g. Pastrami on Rye"
            disabled={searching || applying}
          />
          <button onClick={runSearch} disabled={searching || applying || !query.trim()} style={{ ...btn(BLUE), opacity: searching || applying || !query.trim() ? 0.5 : 1 }}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {searching && (
          <div style={{ fontSize: 12.5, color: '#888', marginTop: 10 }}>
            Searching {locationCount != null ? `${locationCount} ` : ''}locations… (matches by exact item name)
          </div>
        )}
        {searchError && <div style={{ marginTop: 10, fontSize: 13, color: '#C0392B' }}>{searchError}</div>}
      </div>

      {/* Step 2 — Review */}
      {resp && !searching && (
        groups.length === 0 ? (
          <div style={card}>
            <div style={{ fontSize: 14, color: '#666' }}>
              No items named “{resp.query}” found across {resp.totalLocations} locations. Names must match exactly (case-insensitive).
            </div>
          </div>
        ) : (
          <>
            <div style={{ ...card, paddingBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 12 }}>
                Found “{resp.query}” at {resp.matchedLocations} of {resp.totalLocations} locations
              </div>
              <div style={{ background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#8D6E00' }}>
                ⚠ Changes are applied per location. Review carefully before applying — this cannot be undone automatically.
              </div>
            </div>

            {groups.map(g => (
              <div key={g.restaurantRef} style={card}>
                <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 8 }}>{g.restaurantName}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, width: 28 }}></th>
                    <th style={th}>Item</th>
                    <th style={{ ...th, textAlign: 'right' }}>Current base</th>
                    <th style={{ ...th, textAlign: 'right' }}>Current display</th>
                    <th style={{ ...th, width: 120 }}>New base price</th>
                    <th style={{ ...th, width: 150 }}>New display price</th>
                    <th style={{ ...th, width: 40, textAlign: 'center' }}></th>
                  </tr></thead>
                  <tbody>
                    {g.rows.map(r => (
                      <tr key={r.key}>
                        <td style={td}>
                          <input type="checkbox" checked={r.checked} disabled={applying} onChange={e => updateRow(r.key, { checked: e.target.checked })} style={{ accentColor: BLUE }} />
                        </td>
                        <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(r.currentPrice)}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#888' }}>{r.currentDisplayPrice || '—'}</td>
                        <td style={td}>
                          <input type="number" min={0} step="0.01" value={r.newPrice} disabled={applying}
                            onChange={e => updateRow(r.key, { newPrice: e.target.value })} style={{ ...input, width: '100%' }} />
                        </td>
                        <td style={td}>
                          <input type="text" value={r.newDisplayPrice} disabled={applying} placeholder="(preserve)"
                            onChange={e => updateRow(r.key, { newDisplayPrice: e.target.value })} style={{ ...input, width: '100%' }} />
                        </td>
                        <td style={{ ...td, textAlign: 'center' }} title={r.error || ''}>{statusIcon(r.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {/* Step 3 — Apply */}
            <div style={{ ...card, position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, color: '#666' }}>
                {checkedCount} item{checkedCount === 1 ? '' : 's'} selected
                {summary && (
                  <span style={{ marginLeft: 12, fontWeight: 600, color: summary.fail ? '#C0392B' : '#2E7D32' }}>
                    Updated {summary.ok} of {summary.ok + summary.fail}.{summary.fail ? ` ${summary.fail} failed: ${[...new Set(summary.failedLocs)].join(', ')}` : ''}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                {failedCount > 0 && !applying && (
                  <button onClick={() => apply(true)} style={btn('#E76F51')}>Retry failed ({failedCount})</button>
                )}
                <button onClick={() => apply(false)} disabled={applying || checkedCount === 0} style={{ ...btn(DARK), opacity: applying || checkedCount === 0 ? 0.5 : 1 }}>
                  {applying ? 'Applying…' : 'Apply Changes'}
                </button>
              </div>
            </div>
          </>
        )
      )}
    </div>
  )
}
