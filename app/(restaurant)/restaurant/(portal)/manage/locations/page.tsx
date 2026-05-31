'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext, DragOverlay, closestCenter, MeasuringStrategy,
  PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
  defaultAnimateLayoutChanges, type AnimateLayoutChanges,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// Animate sibling rows shifting up/down as the dragged ghost passes over them
// (forces the default to animate even on the post-drop commit, not just while
// sorting).
const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true })
import EditLocationDialog, { type EditLocationFullData } from './EditLocationDialog'
import { useSelectedRestaurant } from '../../_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
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
  // The row currently being dragged + the column widths captured at drag start,
  // so the floating DragOverlay ghost matches the table's column layout.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overlayWidths, setOverlayWidths] = useState<number[]>([])
  const activeLoc = activeId ? locations.find(l => l.reference === activeId) ?? null : null
  const overlayWidth = overlayWidths.reduce((a, b) => a + b, 0)

  // Drag-and-drop: require 6px pointer movement before drag activates so
  // single clicks on the row still register as switch/edit/copy.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
    // All body rows share the same column widths, so measuring any one row's
    // cells gives the widths the overlay <table> needs to line up exactly.
    if (typeof document !== 'undefined') {
      const row = document.querySelector('[data-loc-row]')
      if (row) {
        setOverlayWidths(Array.from(row.querySelectorAll('td')).map(td => (td as HTMLElement).getBoundingClientRect().width))
      }
    }
  }

  function handleDragCancel() {
    setActiveId(null)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = locations.findIndex(l => l.reference === active.id)
    const newIndex = locations.findIndex(l => l.reference === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    // Snapshot the current order so we can roll back if FM rejects the move —
    // otherwise a failed save leaves the optimistic order on screen while a
    // reload silently reverts it (the "reorder not persisting" symptom).
    const previous = locations
    const reordered = arrayMove(locations, oldIndex, newIndex)
    setLocations(reordered)
    // Position is the 0-based index where the row actually LANDED, made
    // absolute across pages. Mirrors FM's drop() (locations.component.ts:115)
    // which sends event.currentIndex (+ page offset) to
    // restaurantService.updatePosition → /system-admin/restaurants/{ref}/position.
    // Derive it from the post-move array so it reflects the true landing spot
    // (the old code reused `newIndex`, the pre-move index of the row dropped
    // ON — which collapses to 0 whenever you drop onto the top row).
    const landedIndex = reordered.findIndex(l => l.reference === active.id)
    const position = landedIndex + page * pageSize
    try {
      const res = await fetch(`/api/restaurant/locations/${active.id}/position?position=${position}`, { method: 'PUT' })
      if (res.ok) {
        showToast('Updated')
      } else {
        setLocations(previous)
        showToast('Could not save the new position. Please try again.')
      }
    } catch {
      setLocations(previous)
      showToast('Could not save the new position. Please try again.')
    }
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
  const clickableCell: React.CSSProperties = { ...cell, cursor: 'pointer' }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }

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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        // Re-measure row rects continuously — the rows move as siblings shift,
        // so the default (measure-once) can resolve the drop target to the
        // wrong row. Always-measuring keeps `over` (the saved position) accurate.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
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
            <SortableContext items={locations.map(l => l.reference)} strategy={verticalListSortingStrategy}>
              <tbody>
                {loading && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
                {!loading && !locations.length && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>No locations.</td></tr>}
                {!loading && locations.map(loc => (
                  <SortableLocationRow
                    key={loc.reference}
                    loc={loc}
                    switching={switching === loc.reference}
                    onToggleStatus={() => toggleStatus(loc)}
                    onSwitch={() => switchToLocation(loc)}
                    onCopy={() => copyLocation(loc)}
                    onEdit={() => openEdit(loc)}
                  />
                ))}
              </tbody>
            </SortableContext>
          </table>
        </div>

        {/* Floating ghost of the dragged row. Rendering it in an overlay (a) lets
            the row follow the cursor smoothly outside the table's flow, and (b)
            fixes drop-target detection in native <table>s — collision is now
            computed against this normally-positioned overlay instead of a
            transformed <tr>, so `over` (and thus the saved position) resolves
            correctly. Width is mirrored from the real row's measured cells. */}
        <DragOverlay>
          {activeLoc ? (
            <table style={{ width: overlayWidth || undefined, tableLayout: 'fixed', borderCollapse: 'collapse', background: '#fff', boxShadow: '0 10px 28px rgba(0,0,0,0.18)', borderRadius: 8, fontFamily: F }}>
              <tbody>
                <tr style={{ background: '#f5f6ff' }}>
                  <LocationCells loc={activeLoc} switching={switching === activeLoc.reference} widths={overlayWidths} />
                </tr>
              </tbody>
            </table>
          ) : null}
        </DragOverlay>
      </DndContext>

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
  // Drag handle (attributes + listeners) for the real row's first cell; omitted
  // for the overlay ghost.
  handleProps?: React.HTMLAttributes<HTMLTableCellElement>
  // Per-column pixel widths, applied only to the overlay ghost so its <table>
  // lines up with the real one.
  widths?: number[]
  onToggleStatus?: () => void
  onSwitch?: () => void
  onCopy?: () => void
  onEdit?: () => void
}

// The seven <td>s of a location row, shared by the live sortable row and the
// drag overlay so they can never visually drift apart.
function LocationCells({ loc, switching, handleProps, widths, onToggleStatus, onSwitch, onCopy, onEdit }: LocationCellsProps) {
  const slug = loc.businessNameWithoutSpaces || ''
  const checkoutHref = slug ? `${DISCO_FRONTEND}${slug}` : ''
  const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
  const clickableCell: React.CSSProperties = { ...cell, cursor: 'pointer' }
  const w = (i: number): React.CSSProperties => (widths && widths[i] != null ? { width: widths[i], boxSizing: 'border-box' } : {})
  return (
    <>
      <td style={{ ...cell, ...w(0), textAlign: 'center', cursor: 'grab', touchAction: 'none' }} {...(handleProps || {})} title="Drag to reorder">
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

interface SortableLocationRowProps {
  loc: Location
  switching: boolean
  onToggleStatus: () => void
  onSwitch: () => void
  onCopy: () => void
  onEdit: () => void
}

function SortableLocationRow({ loc, switching, onToggleStatus, onSwitch, onCopy, onEdit }: SortableLocationRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: loc.reference, animateLayoutChanges })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // While THIS row is the one being dragged it's hidden in place — the
    // DragOverlay renders the floating ghost. Its slot stays, and the sibling
    // rows shift via the sortable transform to show where it will land.
    opacity: isDragging ? 0 : (loc.archived ? 0.6 : 1),
    background: loc.archived ? '#fafafa' : '#fff',
  }
  return (
    <tr ref={setNodeRef} data-loc-row={loc.reference} style={style}>
      <LocationCells
        loc={loc}
        switching={switching}
        handleProps={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLTableCellElement>}
        onToggleStatus={onToggleStatus}
        onSwitch={onSwitch}
        onCopy={onCopy}
        onEdit={onEdit}
      />
    </tr>
  )
}
