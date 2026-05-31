'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import EditLocationDialog, { type EditLocationFullData } from './EditLocationDialog'
import { useSelectedRestaurant } from '../../_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const INDICATOR = '#5B6FE8'
const PAGE_BG = '#F7F8FC'
const DISCO_FRONTEND = 'https://www.discocater.com/restaurants/'

interface Location {
  reference: string
  businessName: string
  businessNameWithoutSpaces?: string
  address?: {
    addressLine1?: string
    city?: string
    state?: string
    zipcode?: string
  }
  createdDate?: string
  blocked?: boolean
  archived?: boolean
}

function fmtRegDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    const yy = String(dt.getFullYear()).slice(-2)
    return `${mm}/${dd}/${yy}`
  } catch { return d }
}

// SVG icons matching FM's Material icons
const IconDrag = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="#bbb" aria-hidden="true">
    <path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/>
  </svg>
)
const IconOpenInNew = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M14 3v2h3.59L7.76 14.83l1.41 1.41L19 6.41V10h2V3zM19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"/>
  </svg>
)
const IconCopy = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
)
const IconEdit = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
)

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      aria-pressed={checked}
      style={{
        width: 36, height: 20, borderRadius: 10, padding: 0,
        background: checked ? BLUE : '#d9d9d9',
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', transition: 'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, background: '#fff', borderRadius: '50%',
        transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
      }} />
    </button>
  )
}

export default function LocationsPage() {
  const router = useRouter()
  const { setRestaurant, setViewMode } = useSelectedRestaurant()
  const [locations, setLocations] = useState<Location[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditLocationFullData | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [toast, setToast] = useState('')

  // ── Drag-and-drop (native HTML5 + aesthetic layer) ─────────────────────────
  // CORE LOGIC IS UNCHANGED: on drop we send one position PUT and re-fetch from
  // FM (see reorder()); we never optimistically reorder the array. Everything
  // below is *visual only* — a floating ghost, live row shifting, and an
  // insertion line. Hover/drop target is resolved from the POINTER against the
  // ORIGINAL row layout (captured at drag start), so the CSS transforms used for
  // the shift animation can never move a row out from under the cursor and
  // change which row the drop lands on.
  const [draggedRef, setDraggedRef] = useState<string | null>(null)
  const [dragOverRef, setDragOverRef] = useState<string | null>(null)
  const [ghostWidth, setGhostWidth] = useState<number | undefined>(undefined)
  const [ghostWidths, setGhostWidths] = useState<number[]>([])

  const containerRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  // Live mirrors of state so the stable window-dragover listener reads fresh values.
  const locationsRef = useRef<Location[]>(locations); locationsRef.current = locations
  const draggedRefRef = useRef<string | null>(draggedRef); draggedRefRef.current = draggedRef
  const dragOverRefRef = useRef<string | null>(dragOverRef); dragOverRefRef.current = dragOverRef
  // Geometry captured at drag start (original, pre-transform layout).
  const grabOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })   // cursor → row top-left
  const ghostStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })   // initial ghost position
  const rowHeightRef = useRef<number>(48)                                   // row height (px)
  const bodyTopViewportRef = useRef<number>(0)                              // first row top (viewport Y)
  const bodyTopRelRef = useRef<number>(0)                                   // first row top (relative to card)
  // 1x1 transparent image → suppress the browser's default drag ghost; ours is custom.
  const dragImgRef = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    const img = document.createElement('img')
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    dragImgRef.current = img
  }, [])

  // Move the ghost with the cursor + resolve the hovered row from the pointer
  // (original layout). Stable identity so add/removeEventListener pair up.
  const onWindowDragOver = useCallback((ev: DragEvent) => {
    ev.preventDefault()
    if (ghostRef.current) {
      const off = grabOffsetRef.current
      ghostRef.current.style.transform = `translate(${ev.clientX - off.x}px, ${ev.clientY - off.y}px)`
    }
    const rh = rowHeightRef.current || 48
    const list = locationsRef.current
    if (!list.length || !rh) return
    let i = Math.floor((ev.clientY - bodyTopViewportRef.current) / rh)
    i = Math.max(0, Math.min(list.length - 1, i))
    const ref = list[i]?.reference
    if (ref && ref !== draggedRefRef.current && ref !== dragOverRefRef.current) {
      setDragOverRef(ref)
    }
  }, [])

  useEffect(() => () => window.removeEventListener('dragover', onWindowDragOver), [onWindowDragOver])

  // Position the ghost at the grabbed row the instant it mounts (no flash).
  useEffect(() => {
    if (draggedRef && ghostRef.current) {
      const s = ghostStartRef.current
      ghostRef.current.style.transform = `translate(${s.x}px, ${s.y}px)`
    }
  }, [draggedRef])

  function endDragVisuals() {
    setDraggedRef(null)
    setDragOverRef(null)
    window.removeEventListener('dragover', onWindowDragOver)
  }

  function handleRowDragStart(e: React.DragEvent, ref: string) {
    setDraggedRef(ref)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', ref) } catch {}
    if (dragImgRef.current) {
      try { e.dataTransfer.setDragImage(dragImgRef.current, 0, 0) } catch {}
    }
    // Measure the original layout for the ghost clone + shift math.
    const rowEl = (e.currentTarget as HTMLElement).closest('tr') as HTMLElement | null
    const cont = containerRef.current
    if (rowEl) {
      const r = rowEl.getBoundingClientRect()
      grabOffsetRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
      ghostStartRef.current = { x: r.left, y: r.top }
      rowHeightRef.current = r.height || 48
      setGhostWidth(r.width)
      setGhostWidths(Array.from(rowEl.querySelectorAll('td')).map(td => (td as HTMLElement).getBoundingClientRect().width))
      const firstRow = cont?.querySelector('tbody tr') as HTMLElement | null
      if (firstRow) {
        const fr = firstRow.getBoundingClientRect()
        bodyTopViewportRef.current = fr.top
        bodyTopRelRef.current = cont ? fr.top - cont.getBoundingClientRect().top : 0
      }
    }
    window.addEventListener('dragover', onWindowDragOver)
  }

  function handleRowDragEnd() {
    endDragVisuals()
  }

  // Drop is handled at the container so it fires no matter where in the table
  // the pointer is released (rows may be transformed by the shift animation).
  // The target row is the pointer-resolved dragOverRef.
  function handleContainerDrop(e: React.DragEvent) {
    e.preventDefault()
    const fromRef = draggedRefRef.current
    const toRef = dragOverRefRef.current
    endDragVisuals()
    if (!fromRef || !toRef || fromRef === toRef) return
    reorder(fromRef, toRef)
  }

  // Persist a single move, then ALWAYS re-fetch so the list reflects FM's saved
  // order. The target index of the dropped-on row is the position FM expects
  // (it removes the dragged restaurant, then inserts at `position`).
  async function reorder(fromRef: string, toRef: string) {
    const toIndex = locations.findIndex(l => l.reference === toRef)
    if (toIndex < 0) return
    const position = toIndex + page * pageSize
    let ok = false
    try {
      const res = await fetch(`/api/restaurant/locations/${fromRef}/position?position=${position}`, { method: 'PUT' })
      ok = res.ok
    } catch { ok = false }
    showToast(ok ? 'Updated' : 'Could not save the new position. Please try again.')
    // Re-fetch from FM (sorted by locationPosition) on BOTH success and failure
    // so the displayed order always equals the server's order.
    await load()
  }

  // Restore page size from localStorage like FM does
  useEffect(() => {
    try {
      const stored = localStorage.getItem('locationCurrentPaginationSize')
      if (stored) {
        const n = parseInt(stored, 10)
        if (!isNaN(n) && [25, 50, 100, 250].includes(n)) setPageSize(n)
      }
    } catch {}
  }, [])

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (page > 0) params.set('page', String(page))
      params.set('size', String(pageSize))
      if (search) params.set('search', search)
      // Order by the saved drag position. FM's list endpoint only honors
      // locationPosition when a sort param is present — with none it returns the
      // managedRestaurants HashSet in arbitrary order, so reorders (persisted via
      // PUT .../position) never show. "locationPosition" isn't one of the
      // backend's named sort cases, so it hits the default branch:
      // Comparator.comparing(Restaurant::getLocationPosition). (FM's own UI omits
      // this, which is why its reorder doesn't stick either.)
      params.append('sort', 'locationPosition,asc')
      const res = await fetch(`/api/restaurant/locations?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error || `Failed to load locations (status ${res.status})`)
        setLocations([])
        setTotal(0)
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

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  async function toggleStatus(loc: Location) {
    if (loc.archived) return
    // FM: checked=!blocked. Clicking flips it. blockedParam = !nextChecked.
    const blockedParam = !loc.blocked
    setLocations(prev => prev.map(l => l.reference === loc.reference ? { ...l, blocked: blockedParam } : l))
    const res = await fetch(`/api/restaurant/locations/${loc.reference}/block?blocked=${blockedParam}`, { method: 'PUT' })
    if (res.ok) {
      showToast(`Online ordering for ${loc.businessName} successfully changed!`)
    } else {
      setLocations(prev => prev.map(l => l.reference === loc.reference ? { ...l, blocked: !blockedParam } : l))
    }
  }

  async function copyLocation(loc: Location) {
    const res = await fetch(`/api/restaurant/locations/${loc.reference}/clone`, { method: 'POST' })
    if (res.ok) {
      showToast(`Copy for ${loc.businessName} successfully created!`)
      setPage(0)
      load()
    }
  }

  async function switchToLocation(loc: Location) {
    setSwitching(loc.reference)
    try {
      // setRestaurant handles the FM PUT + localStorage + broadcast +
      // refreshName so the sidebar header updates in one shot.
      await setRestaurant(loc.reference, loc.businessName)
      // Clicking a location is the "manage this location operationally"
      // intent — flip into the narrow Restaurant User nav (Orders,
      // Manage Menus, Availability) and land on Orders.
      setViewMode('RESTAURANT_USER')
      router.push('/restaurant/orders')
    } finally {
      setSwitching(null)
    }
  }

  async function openEdit(loc: Location) {
    setEditLoading(true)
    try {
      // Fetch the full location object so the dialog has categories,
      // fulfillment options, images, lat/lng — fields not in the list response.
      const res = await fetch(`/api/restaurant/locations/${loc.reference}`)
      if (res.ok) {
        const full = await res.json()
        setEditing(full as EditLocationFullData)
      } else {
        // Fall back to the list row so the dialog still opens
        setEditing(loc as EditLocationFullData)
      }
    } finally {
      setEditLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: 0.3, padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
  const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }

  // Derived drag geometry for the visual layer (no effect on the saved order).
  const fromIndex = draggedRef ? locations.findIndex(l => l.reference === draggedRef) : -1
  const overIndex = dragOverRef ? locations.findIndex(l => l.reference === dragOverRef) : -1
  const dragging = fromIndex >= 0 && overIndex >= 0 && fromIndex !== overIndex
  const rh = rowHeightRef.current || 48
  // Shift every row at/after the insertion slot down to open a one-row gap; the
  // dragged source row stays put (dimmed). Pointer hit-testing uses the original
  // layout, so this is purely cosmetic.
  function shiftFor(i: number): number {
    if (!dragging || i === fromIndex) return 0
    return i >= overIndex ? rh : 0
  }
  const indicatorTop = dragging ? bodyTopRelRef.current + overIndex * rh : null
  const draggedLoc = draggedRef ? locations.find(l => l.reference === draggedRef) ?? null : null

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Locations</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Search…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ ...input, width: 260 }}
          />
        </div>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <div
        ref={containerRef}
        onDragOver={dragging || draggedRef ? e => e.preventDefault() : undefined}
        onDrop={draggedRef ? handleContainerDrop : undefined}
        style={{ position: 'relative', background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <colgroup>
            <col style={{ width: 36 }} />
            <col style={{ width: 90 }} />
            <col />
            <col />
            <col style={{ width: 130 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 110 }} />
          </colgroup>
          <thead><tr>
            <th style={colHead}></th>
            <th style={colHead}>STATUS:</th>
            <th style={colHead}>RESTAURANT:</th>
            <th style={colHead}>ADDRESS:</th>
            <th style={colHead}>REGISTRATION:</th>
            <th style={colHead}>CHECKOUT:</th>
            <th style={colHead}></th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !locations.length && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>No locations.</td></tr>}
            {!loading && locations.map((loc, i) => (
              <LocationRow
                key={loc.reference}
                loc={loc}
                isDragged={draggedRef === loc.reference}
                shift={shiftFor(i)}
                switching={switching === loc.reference}
                onDragStart={e => handleRowDragStart(e, loc.reference)}
                onDragEnd={handleRowDragEnd}
                onToggleStatus={() => toggleStatus(loc)}
                onSwitch={() => switchToLocation(loc)}
                onCopy={() => copyLocation(loc)}
                onEdit={() => openEdit(loc)}
              />
            ))}
          </tbody>
        </table>

        {/* Insertion line — the exact spot the dragged row will land. */}
        {indicatorTop != null && (
          <div style={{ position: 'absolute', left: 0, right: 0, top: indicatorTop - 1, height: 2, background: INDICATOR, zIndex: 4, pointerEvents: 'none' }} />
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>
          Showing {locations.length} of {total} location{total === 1 ? '' : 's'}
          {!loading && total === locations.length && total > 0 && (
            <span style={{ marginLeft: 8, color: '#aaa' }}>
              · this is everything the FM endpoint returns for this account
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select
            value={pageSize}
            onChange={e => {
              const v = Number(e.target.value)
              setPage(0); setPageSize(v)
              try { localStorage.setItem('locationCurrentPaginationSize', String(v)) } catch {}
            }}
            style={{ border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }}
          >
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {/* Floating ghost — a clone of the dragged row that follows the cursor.
          Rendered outside the card (and pointer-events:none) so it never clips
          or intercepts the drop. Position is set imperatively in the dragover
          listener; initial spot via the [draggedRef] effect. */}
      {draggedLoc && (
        <div ref={ghostRef} style={{ position: 'fixed', left: 0, top: 0, zIndex: 1000, pointerEvents: 'none', opacity: 0.9, width: ghostWidth, willChange: 'transform' }}>
          <table style={{ width: ghostWidth, tableLayout: 'fixed', borderCollapse: 'collapse', background: '#fff', boxShadow: '0 10px 28px rgba(0,0,0,0.22)', borderRadius: 8, fontFamily: F }}>
            <tbody>
              <tr style={{ background: '#f5f6ff' }}>
                <LocationCells loc={draggedLoc} switching={false} widths={ghostWidths} />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, background: DARK, color: '#fff',
          padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 400,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {toast}
        </div>
      )}

      {editLoading && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 290, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14 }}>
          Loading location…
        </div>
      )}

      {editing && (
        <EditLocationDialog
          location={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            showToast(msg)
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#666', cursor: 'pointer',
  padding: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}
const pageBtn: React.CSSProperties = {
  background: '#fff', border: '1px solid #ddd', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK,
}

interface LocationCellsProps {
  loc: Location
  switching: boolean
  // Drag handle props for the first cell (real row only); omitted for the ghost.
  dragHandle?: { draggable: boolean; onDragStart: (e: React.DragEvent) => void; onDragEnd: (e: React.DragEvent) => void }
  // Per-column pixel widths — applied only to the ghost so its <table> lines up.
  widths?: number[]
  onToggleStatus?: () => void
  onSwitch?: () => void
  onCopy?: () => void
  onEdit?: () => void
}

// The seven <td>s of a location row, shared by the live row and the ghost clone
// so they can never visually drift apart.
function LocationCells({ loc, switching, dragHandle, widths, onToggleStatus, onSwitch, onCopy, onEdit }: LocationCellsProps) {
  const slug = loc.businessNameWithoutSpaces || ''
  const checkoutHref = slug ? `${DISCO_FRONTEND}${slug}` : ''
  const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
  const clickableCell: React.CSSProperties = { ...cell, cursor: 'pointer' }
  const w = (i: number): React.CSSProperties => (widths && widths[i] != null ? { width: widths[i], boxSizing: 'border-box' } : {})
  return (
    <>
      {/* Only the drag handle is draggable, so clicks on the other cells still
          switch/edit the location. */}
      <td {...(dragHandle || {})} style={{ ...cell, ...w(0), textAlign: 'center', cursor: 'grab' }} title="Drag to reorder">
        <IconDrag />
      </td>
      <td style={{ ...cell, ...w(1) }}>
        <Toggle checked={!loc.blocked} onChange={onToggleStatus || (() => {})} disabled={loc.archived} />
      </td>
      <td style={{ ...clickableCell, ...w(2), fontWeight: 500 }} onClick={onSwitch} title="Switch to this restaurant">
        {loc.businessName}
        {switching && <span style={{ marginLeft: 6, color: '#aaa', fontSize: 11 }}>switching…</span>}
      </td>
      <td style={{ ...clickableCell, ...w(3), color: '#555' }} onClick={onSwitch}>
        {loc.address?.addressLine1 || ''}
      </td>
      <td style={{ ...clickableCell, ...w(4), color: '#666' }} onClick={onSwitch}>
        {fmtRegDate(loc.createdDate)}
      </td>
      <td style={{ ...cell, ...w(5) }}>
        {checkoutHref ? (
          <a
            href={checkoutHref}
            target="_blank"
            rel="noreferrer"
            title={checkoutHref}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6, background: BLUE, color: '#fff',
              textDecoration: 'none',
            }}
          >
            <IconOpenInNew />
          </a>
        ) : <span style={{ color: '#bbb' }}>—</span>}
      </td>
      <td style={{ ...cell, ...w(6), textAlign: 'right' }}>
        <div style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
          <button onClick={onCopy} title="Copy" style={iconBtn}><IconCopy /></button>
          <button onClick={onEdit} title="Edit" style={iconBtn}><IconEdit /></button>
        </div>
      </td>
    </>
  )
}

interface LocationRowProps {
  loc: Location
  isDragged: boolean
  shift: number
  switching: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: (e: React.DragEvent) => void
  onToggleStatus: () => void
  onSwitch: () => void
  onCopy: () => void
  onEdit: () => void
}

function LocationRow({
  loc, isDragged, shift, switching,
  onDragStart, onDragEnd,
  onToggleStatus, onSwitch, onCopy, onEdit,
}: LocationRowProps) {
  return (
    <tr
      style={{
        transform: shift ? `translateY(${shift}px)` : undefined,
        transition: 'transform 0.16s ease',
        // The dragged row stays dimmed in place — the floating ghost is its
        // moving representation.
        opacity: isDragged ? 0.4 : (loc.archived ? 0.6 : 1),
        background: loc.archived ? '#fafafa' : '#fff',
      }}
    >
      <LocationCells
        loc={loc}
        switching={switching}
        dragHandle={{ draggable: true, onDragStart, onDragEnd }}
        onToggleStatus={onToggleStatus}
        onSwitch={onSwitch}
        onCopy={onCopy}
        onEdit={onEdit}
      />
    </tr>
  )
}
