'use client'
import { useState, useEffect, useCallback } from 'react'
import AddRestaurantDialog from './AddRestaurantDialog'
import EditRestaurantDialog from '../EditRestaurantDialog'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

const STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED'] as const

interface Restaurant {
  // Stable, guaranteed-unique per-row id assigned on load. FM's ordering list
  // can return the SAME `reference` for several multi-unit locations (e.g.
  // multiple "Colonial Ranch Market" rows), so `reference` is NOT safe as the
  // React key or the optimistic-update match — doing so flipped every matching
  // row at once. `_rowId` keeps each rendered row independent; FM API calls
  // still use the real `reference`.
  _rowId: string
  reference: string
  businessName: string
  url?: string
  blocked?: boolean
  nashAllowed?: boolean
  shipdayEnabled?: boolean
  moneyFlow?: string // 'FAMILY_MEAL' (held) | 'DIRECT' (released)
  onlineOrderingAllowed?: boolean
  restaurantStatus?: string
  createdDate?: string
  adminName?: string
  adminEmail?: string
  admin?: { firstName?: string; lastName?: string; email?: string }
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    const yy = String(dt.getFullYear()).slice(-2)
    return `${mm}/${dd}/${yy}`
  } catch { return d }
}

function Toggle({ checked, onChange, disabled, color = BLUE }: { checked: boolean; onChange: () => void; disabled?: boolean; color?: string }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      aria-pressed={checked}
      style={{
        width: 32, height: 18, borderRadius: 9, padding: 0,
        background: checked ? color : '#d9d9d9',
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', transition: 'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 16 : 2,
        width: 14, height: 14, background: '#fff', borderRadius: '50%',
        transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
      }} />
    </button>
  )
}

// Stripe Connect status per row. No indicator until the status has been synced
// (checkedAt === null). Green = connected, grey = not connected.
function StripeStatus({ status }: { status?: { connected: boolean; checkedAt: string | null } }) {
  if (!status || !status.checkedAt) return <span style={{ color: '#ccc', fontSize: 12 }}>—</span>
  const dot = (color: string) => (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' }} />
  )
  return status.connected
    ? <span style={{ fontSize: 12, color: '#1D9E75', whiteSpace: 'nowrap' }}>{dot('#1D9E75')}Connected</span>
    : <span style={{ fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>{dot('#bbb')}Not connected</span>
}

export default function RestaurantsOrderingPage() {
  const [rows, setRows] = useState<Restaurant[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(pageSize))
    if (search) params.set('search', search)
    if (statusFilter) params.set('restaurantStatus', statusFilter)
    const res = await fetch(`/api/admin/restaurants?${params}`)
    if (res.ok) {
      const d = await res.json()
      // Tag every row with a unique local id. FM can repeat `reference` across
      // multi-unit locations, so we suffix with the array index to guarantee
      // uniqueness for React keys + per-row optimistic updates.
      const content: Restaurant[] = (d.content || []).map((r: Restaurant, i: number) => ({
        ...r,
        _rowId: `${r.reference ?? 'noref'}#${i}`,
      }))
      setRows(content)
      setTotal(d.totalElements || 0)
    } else {
      setError('Failed to load restaurants')
      setRows([])
      setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize, search, statusFilter])

  useEffect(() => { load() }, [load])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  async function toggleBlock(r: Restaurant) {
    const next = !r.blocked
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, blocked: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/block?block=${next}`, { method: 'POST' })
    if (!res.ok) {
      setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, blocked: !next } : x))
    } else {
      showToast(`${r.businessName} ${next ? 'blocked' : 'unblocked'}`)
    }
  }

  async function toggleNash(r: Restaurant) {
    const next = !r.nashAllowed
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, nashAllowed: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/nash?nashAllowed=${next}`, { method: 'PATCH' })
    if (!res.ok) setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, nashAllowed: !next } : x))
  }

  // FM has a single Shipday toggle (restaurant.service.ts:317 —
  // PATCH /api/admin/restaurants/{ref}/shipdayEnabled). There are no split
  // delivery/pickup endpoints; the earlier split returned 404.
  async function toggleShipday(r: Restaurant) {
    const next = !r.shipdayEnabled
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, shipdayEnabled: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/shipday?shipdayEnabled=${next}`, { method: 'PATCH' })
    if (!res.ok) setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, shipdayEnabled: !next } : x))
  }

  // "Hold Payments on FamilyMeal": ON = moneyFlow FAMILY_MEAL (held),
  // OFF = DIRECT (released). FM restaurant-table.component.ts:387-400.
  async function toggleMoneyFlow(r: Restaurant) {
    const held = r.moneyFlow !== 'DIRECT'
    const next = held ? 'DIRECT' : 'FAMILY_MEAL'
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, moneyFlow: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/money-flow?moneyFlow=${next}`, { method: 'PUT' })
    if (!res.ok) setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, moneyFlow: held ? 'FAMILY_MEAL' : 'DIRECT' } : x))
    else showToast(`${r.businessName}: payments ${next === 'FAMILY_MEAL' ? 'held' : 'released'}`)
  }

  async function deleteRestaurant(r: Restaurant) {
    if (!confirm(`Delete "${r.businessName}"? This cannot be undone.`)) return
    const res = await fetch(`/api/admin/restaurants/${r.reference}`, { method: 'DELETE' })
    if (res.ok) { showToast(`${r.businessName} deleted`); load() }
    else showToast('Delete failed')
  }

  async function changeStatus(r: Restaurant, status: string) {
    if (status === r.restaurantStatus) return
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, restaurantStatus: status } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/status?status=${status}`, { method: 'POST' })
    if (res.ok) showToast(`${r.businessName} → ${status}`)
    else load() // revert by reload
  }

  async function resetPassword(r: Restaurant) {
    if (!confirm(`Send password reset for ${r.adminEmail || r.admin?.email}?`)) return
    const res = await fetch(`/api/admin/restaurants/${r.reference}/reset-password`, { method: 'PUT' })
    if (res.ok) showToast('Password reset email sent')
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const [addOpen, setAddOpen] = useState(false)
  const [editRef, setEditRef] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncProgress, setSyncProgress] = useState('')
  const [cacheBusy, setCacheBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [enrichBusy, setEnrichBusy] = useState(false)
  const [enrichProgress, setEnrichProgress] = useState('')

  // One-time: pull cuisine/description/image from Sanity into the map cache.
  async function importSanityData() {
    if (!confirm('This will import cuisine, description and images from Sanity into the map cache. Continue?')) return
    setImportBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/import-sanity-restaurants', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Sanity import failed')
      showToast(`Sanity import: ${d.matched} matched, ${d.inserted} inserted, ${d.skipped} skipped, ${d.premium ?? 0} marked Premium`)
    } catch (e) {
      setError((e as Error).message || 'Sanity import failed')
    } finally {
      setImportBusy(false)
    }
  }

  // Rebuild the public map cache (disco_restaurant_cache) from FM.
  async function refreshMapCache() {
    if (!confirm('This will rebuild the map cache from FM (all active restaurants). Continue?')) return
    setCacheBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/refresh-restaurant-cache', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Cache refresh failed')
      showToast(`Map cache refreshed: ${d.cached} cached of ${d.total} fetched (${Math.round((d.durationMs || 0) / 1000)}s)`)
    } catch (e) {
      setError((e as Error).message || 'Cache refresh failed')
    } finally {
      setCacheBusy(false)
    }
  }
  // Per-restaurant Stripe status (keyed by reference) from Neon overrides, shown
  // as a column on each row. checkedAt === null means "never synced".
  const [stripeMap, setStripeMap] = useState<Record<string, { connected: boolean; checkedAt: string | null }>>({})

  const loadStripeMap = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/restaurant-overrides')
      if (!res.ok) return
      const d = await res.json()
      const map: Record<string, { connected: boolean; checkedAt: string | null }> = {}
      for (const o of (d?.overrides || []) as { restaurantReference: string; stripeConnected: boolean; stripeCheckedAt: string | null }[]) {
        map[o.restaurantReference] = { connected: !!o.stripeConnected, checkedAt: o.stripeCheckedAt }
      }
      setStripeMap(map)
    } catch { /* non-fatal: the column just won't render */ }
  }, [])

  useEffect(() => { loadStripeMap() }, [loadStripeMap])

  // Probe FM Stripe Connect status for every visible restaurant, one batch at a
  // time (each request stays under the function-duration limit), looping until
  // the route reports done. Stops on the first failed batch.
  async function syncStripeStatus() {
    if (!confirm('This will check Stripe Connect status for all visible restaurants. This may take several minutes. Continue?')) return
    setSyncBusy(true)
    setSyncProgress('')
    setError('')
    const BATCH = 25
    let offset = 0
    let connected = 0
    let notConnected = 0
    let total = 0
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch('/api/admin/sync-stripe-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: BATCH, offset }),
        })
        const d = await res.json().catch(() => null)
        if (!res.ok) throw new Error(d?.error || 'Stripe status sync failed')

        connected += d.connected || 0
        notConnected += d.notConnected || 0
        total = d.total || 0
        setSyncProgress(`Syncing… ${Math.min(d.nextOffset, total)}/${total}`)

        if (d.done) break
        offset = d.nextOffset
      }
      showToast(`Stripe sync complete: ${connected} connected, ${notConnected} not connected (of ${total})`)
      await loadStripeMap()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ((e as { error?: string })?.error || String(e))
      setError(msg || 'Stripe status sync failed')
    } finally {
      setSyncBusy(false)
      setSyncProgress('')
    }
  }

  // Enrich cache rows missing cuisine/description/image via Google Places, one
  // batch at a time, looping until the route reports done. Stops on first error.
  async function enrichWithGoogle() {
    if (!confirm('This will look up cuisine, descriptions, and images from Google Places for restaurants missing them. This may take several minutes. Continue?')) return
    setEnrichBusy(true)
    setEnrichProgress('')
    setError('')
    const BATCH = 25
    let offset = 0
    let enriched = 0
    let notFound = 0
    let skipped = 0
    let processed = 0
    let total = 0
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch('/api/admin/enrich-restaurants-places', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: BATCH, offset }),
        })
        const d = await res.json().catch(() => null)
        console.log('[Enrich] Batch result:', JSON.stringify(d))
        if (!res.ok) throw new Error(d?.error || 'Enrichment failed')

        enriched += d.enriched || 0
        notFound += d.notFound || 0
        skipped += d.skipped || 0
        processed += (d.enriched || 0) + (d.notFound || 0) + (d.skipped || 0)
        // `total` shrinks as rows are enriched, so anchor the denominator to the
        // largest total + processed count we've seen for a stable progress bar.
        total = Math.max(total, (d.total || 0) + enriched)
        setEnrichProgress(`Enriching… ${Math.min(processed, total)}/${total}`)

        if (d.done) break
        offset = d.nextOffset
      }
      showToast(`Enrichment complete: ${enriched} enriched, ${notFound} not found, ${skipped} skipped`)
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ((e as { error?: string })?.error || String(e))
      setError(msg || 'Enrichment failed')
    } finally {
      setEnrichBusy(false)
      setEnrichProgress('')
    }
  }

  // One-time: show every active FM restaurant on the Disco fullmap.
  async function bulkSetVisible() {
    if (!confirm('This will show all active FM restaurants on the Disco Cater map. Continue?')) return
    setBulkBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/bulk-set-visible', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Bulk update failed')
      showToast(`Map updated: ${d.inserted} added, ${d.updated} already-present set visible`)
    } catch (e) {
      setError((e as Error).message || 'Bulk update failed')
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      {/* CSS-only hover tooltips for the header action buttons. */}
      <style>{`
        .ord-btn { position: relative; }
        .ord-tip {
          position: absolute;
          top: calc(100% + 6px);
          left: 50%;
          transform: translateX(-50%);
          background: #1A1028;
          color: #fff;
          font-size: 12px;
          font-weight: 500;
          line-height: 1.4;
          text-align: center;
          border-radius: 6px;
          padding: 6px 10px;
          max-width: 200px;
          width: max-content;
          white-space: normal;
          z-index: 100;
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition: opacity 0.12s ease;
        }
        .ord-btn:hover .ord-tip { opacity: 1; visibility: visible; }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Restaurants — Ordering</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0) }} style={{ ...selectSt, minWidth: 160 }}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            type="text" placeholder="Search…" value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ ...inputSt, width: 240 }}
          />
          <button className="ord-btn" onClick={bulkSetVisible} disabled={bulkBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: bulkBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: bulkBusy ? 0.6 : 1 }}>
            {bulkBusy ? 'Setting…' : 'Bulk Set Visible'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Mark all active FM restaurants as visible on the Disco Cater map</span>
          </button>
          <button className="ord-btn" onClick={syncStripeStatus} disabled={syncBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: syncBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: syncBusy ? 0.6 : 1 }}>
            {syncBusy ? (syncProgress || 'Syncing…') : 'Sync Stripe Status'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Check which restaurants have Stripe Connect set up (required to accept orders)</span>
          </button>
          <button className="ord-btn" onClick={refreshMapCache} disabled={cacheBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: cacheBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: cacheBusy ? 0.6 : 1 }}>
            {cacheBusy ? 'Refreshing…' : 'Refresh Map Cache'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Rebuild the restaurant map data from FamilyMeal (run after adding new restaurants)</span>
          </button>
          {/* "Import Sanity Data" button hidden per request — importSanityData()
              and /api/admin/import-sanity-restaurants remain available. */}
          <button className="ord-btn" onClick={enrichWithGoogle} disabled={enrichBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: enrichBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: enrichBusy ? 0.6 : 1 }}>
            {enrichBusy ? (enrichProgress || 'Enriching…') : 'Enrich with Google'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Fetch cuisine, descriptions and photos from Google Places for restaurants missing this data</span>
          </button>
          <button onClick={() => setAddOpen(true)}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
            + Add Restaurant
          </button>
        </div>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {/* Scroll the rows inside this container (max-height) so the sticky
          header has a scrolling ancestor to pin against. No overflow:hidden
          ancestor here, so sticky works without z-index hacks. */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto', maxHeight: 'calc(100vh - 240px)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1500 }}>
          <thead>
            <tr>
              <th style={colHead}>Marketplace</th>
              <th style={colHead}>Restaurant</th>
              <th style={colHead}>Admin</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Registration Date</th>
              <th style={colHead}>Checkout Page</th>
              <th style={colHead}>Stripe</th>
              <th style={colHead}>Status</th>
              <th style={colHead}>Third-Party Allowed</th>
              <th style={colHead}>Hold Payments</th>
              <th style={colHead}>Shipday</th>
              {/* Pinned to the right edge so the action buttons stay visible
                  (and never clip) while the wide table scrolls horizontally. */}
              <th style={{ ...colHead, textAlign: 'right', position: 'sticky', right: 0, top: 0, zIndex: 3, minWidth: 120, borderLeft: '1px solid #f0f0f0' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={12} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={12} style={{ ...cell, textAlign: 'center', color: '#999' }}>No restaurants.</td></tr>}
            {!loading && rows.map(r => {
              const adminName = r.adminName || `${r.admin?.firstName || ''} ${r.admin?.lastName || ''}`.trim()
              const adminEmail = r.adminEmail || r.admin?.email || ''
              return (
                <tr key={r._rowId}>
                  {/* Marketplace: ON = visible (NOT blocked), mirroring FM's
                      [checked]="!element.blocked". */}
                  <td style={cell}>
                    <Toggle checked={!r.blocked} onChange={() => toggleBlock(r)} color="#1D9E75" />
                  </td>
                  <td style={{ ...cell, fontWeight: 600 }}>{r.businessName}</td>
                  <td style={{ ...cell, color: '#555' }}>{adminName || '—'}</td>
                  <td style={{ ...cell, color: '#555' }}>{adminEmail}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(r.createdDate)}</td>
                  <td style={cell}>
                    {r.url ? <a href={r.url} target="_blank" rel="noreferrer" style={{ color: BLUE, textDecoration: 'none' }}>open ↗</a> : '—'}
                  </td>
                  <td style={cell}><StripeStatus status={stripeMap[r.reference]} /></td>
                  <td style={cell}>
                    <select value={r.restaurantStatus || ''} onChange={e => changeStatus(r, e.target.value)} style={smallSelect}>
                      {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={cell}><Toggle checked={!!r.nashAllowed} onChange={() => toggleNash(r)} /></td>
                  <td style={cell}><Toggle checked={r.moneyFlow !== 'DIRECT'} onChange={() => toggleMoneyFlow(r)} color="#EFB84A" /></td>
                  <td style={cell}><Toggle checked={!!r.shipdayEnabled} onChange={() => toggleShipday(r)} /></td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap', position: 'sticky', right: 0, zIndex: 1, minWidth: 120, background: '#fff', borderLeft: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <button title="Refresh" onClick={() => load()} style={iconBtn}>⟳</button>
                      <button title="Edit" onClick={() => setEditRef(r.reference)} style={iconBtn}>✎</button>
                      <button title="Delete" onClick={() => deleteRestaurant(r)} style={{ ...iconBtn, color: '#E53935' }}>🗑</button>
                      <Kebab onResetPassword={() => resetPassword(r)} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{total} restaurant{total === 1 ? '' : 's'}</div>
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

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, background: DARK, color: '#fff',
          padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 400,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>{toast}</div>
      )}

      {/* Visual hint for the gold theme — show on hover of status select */}
      <style>{`
        select:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; }
      `}</style>

      {addOpen && (
        <AddRestaurantDialog
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); showToast('Restaurant created'); setPage(0); load() }}
        />
      )}

      {editRef && (
        <EditRestaurantDialog
          restaurantRef={editRef}
          onClose={() => setEditRef(null)}
          onSaved={(msg) => { setEditRef(null); showToast(msg); load() }}
        />
      )}
    </div>
  )
}

function Kebab({ onResetPassword }: { onResetPassword: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button title="More" onClick={() => setOpen(o => !o)} style={iconBtn}>⋯</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
          <div style={{ position: 'absolute', right: 0, top: '100%', background: '#fff', border: '1px solid #eee', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', zIndex: 51, minWidth: 160 }}>
            <button onClick={() => { setOpen(false); onResetPassword() }}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '10px 14px', fontSize: 13, color: DARK, cursor: 'pointer', fontFamily: F }}>
              Reset password
            </button>
          </div>
        </>
      )}
    </span>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2 }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const iconBtn: React.CSSProperties = { background: '#f5f5f8', border: '1px solid #e8e8ee', borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer', color: '#555', fontFamily: F, lineHeight: 1 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
