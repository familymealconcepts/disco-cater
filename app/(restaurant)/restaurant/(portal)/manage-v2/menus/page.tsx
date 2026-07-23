'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import MenuSettingsDialog from './MenuSettingsDialog'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

interface Menu {
  reference: string
  name: string
  menuType: string
  startDate: string
  endDate: string
  image?: { reference: string }
  visible: boolean
  archived: boolean
  // Manage Menus table columns (enriched by /api/restaurant/menus):
  itemCount?: number
  leadTimeHours?: number | null
  serviceTypes?: string[] // e.g. ['PICKUP', 'DELIVERY']
}

// Render helpers for the Items / Lead Time / Service Types columns.
function fmtItems(n?: number): string {
  const c = n ?? 0
  return `${c} item${c === 1 ? '' : 's'}`
}
function fmtLeadTime(h?: number | null): string {
  return h && h > 0 ? `${h} hr${h === 1 ? '' : 's'}` : '—'
}
function fmtServiceTypes(types?: string[]): string {
  if (!types || !types.length) return '—'
  const label = (t: string) => (t.toUpperCase() === 'PICKUP' ? 'Pickup' : t.toUpperCase() === 'DELIVERY' ? 'Delivery' : t)
  // Show Pickup before Delivery for a consistent, readable order.
  const order = (t: string) => (t.toUpperCase() === 'PICKUP' ? 0 : 1)
  return [...types].sort((a, b) => order(a) - order(b)).map(label).join(', ')
}

type FilterType = 'ACTIVE' | 'NON_VISIBLE' | 'ARCHIVED'

const TABS: { label: string; filter: FilterType }[] = [
  { label: 'Active Menus', filter: 'ACTIVE' },
  { label: 'Inactive Menus', filter: 'NON_VISIBLE' },
  { label: 'Archived Menus', filter: 'ARCHIVED' },
]

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 400, width: '90%', fontFamily: F }}>
        <p style={{ margin: '0 0 24px', color: DARK, fontSize: 15 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={onConfirm} style={{ background: '#E53935', border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, color: '#fff', cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Confirm</button>
        </div>
      </div>
    </div>
  )
}

export default function MenusPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState(0)
  const [menus, setMenus] = useState<Menu[]>([])
  const [loading, setLoading] = useState(true)
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null)
  const [settingsRef, setSettingsRef] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Fail-safe: this FM-backed menu UI 404s for Disco-native restaurants (FM has
  // no record of them). The nav routes Disco sessions to the Neon menu-manager,
  // but a stale bookmark / deep link could still land one here — bounce those to
  // the native UI. FM sessions (/me 401s) stay on this page untouched.
  useEffect(() => {
    let cancelled = false
    fetch('/api/disco-restaurant-auth/me', { credentials: 'include' })
      .then(r => { if (!cancelled && r.ok) router.replace('/restaurant/menu-manager') })
      .catch(() => {})
    return () => { cancelled = true }
  }, [router])

  const filter = TABS[activeTab].filter

  // Drag-to-reorder. 6px activation distance so a click still opens the menu.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = menus.findIndex(m => m.reference === active.id)
    const newIndex = menus.findIndex(m => m.reference === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(menus, oldIndex, newIndex)
    setMenus(reordered)
    // Single page (size=100), so the list index is the absolute position.
    // Mirrors FM menu.service.ts:66 — PUT /api/menu/{ref}/position?position=.
    await fetch(`/api/restaurant/menus/${active.id}/position?position=${newIndex}`, { method: 'PUT' })
  }

  const loadMenus = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/restaurant/menus?filter=${filter}&page=0&size=100`)
      if (res.ok) {
        const d = await res.json()
        setMenus(d.content || [])
      }
    } finally { setLoading(false) }
  }, [filter])

  useEffect(() => { loadMenus() }, [loadMenus])

  function ask(message: string, onConfirm: () => void) {
    setConfirm({ message, onConfirm })
  }

  async function handleDelete(ref: string, name: string) {
    ask(`Delete menu "${name}"? This cannot be undone.`, async () => {
      setConfirm(null)
      await fetch(`/api/restaurant/menus/${ref}`, { method: 'DELETE' })
      loadMenus()
    })
  }

  async function handleClone(ref: string) {
    await fetch(`/api/restaurant/menus/${ref}/clone`, { method: 'POST' })
    loadMenus()
  }

  async function handleArchive(ref: string, isArchived: boolean) {
    await fetch(`/api/restaurant/menus/${ref}/archive?isArchived=${!isArchived}`, { method: 'PUT' })
    loadMenus()
  }

  async function handleVisible(ref: string, isVisible: boolean) {
    await fetch(`/api/restaurant/menus/${ref}/visible?isVisible=${!isVisible}`, { method: 'PUT' })
    loadMenus()
  }

  const thStyle: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#888', padding: '10px 12px', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
  const tdStyle: React.CSSProperties = { padding: '12px', fontSize: 13, color: DARK, verticalAlign: 'middle' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Menus</h1>
        <button
          onClick={() => setCreating(true)}
          style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
        >
          + Create Menu
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #eee' }}>
        {TABS.map((t, i) => (
          <button
            key={t.filter}
            onClick={() => setActiveTab(i)}
            style={{
              background: 'transparent', border: 'none', borderBottom: activeTab === i ? `2px solid ${BLUE}` : '2px solid transparent',
              padding: '10px 16px', fontSize: 13, fontWeight: activeTab === i ? 600 : 400,
              color: activeTab === i ? BLUE : '#666', cursor: 'pointer', fontFamily: F, marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading...</div>
        ) : menus.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>No menus found.</div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fafafa' }}>
                <th style={{ ...thStyle, width: 34 }} aria-label="Reorder" />
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Items</th>
                <th style={thStyle}>Lead Time</th>
                <th style={thStyle}>Service Types</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              <SortableContext items={menus.map(m => m.reference)} strategy={verticalListSortingStrategy}>
                {menus.map(m => (
                  <SortableMenuRow
                    key={m.reference}
                    m={m}
                    filter={filter}
                    tdStyle={tdStyle}
                    onOpen={() => router.push(`/restaurant/manage-v2/${m.reference}`)}
                    onSettings={() => setSettingsRef(m.reference)}
                    onClone={() => handleClone(m.reference)}
                    onVisible={() => handleVisible(m.reference, m.visible)}
                    onArchive={() => handleArchive(m.reference, m.archived)}
                    onDelete={() => handleDelete(m.reference, m.name)}
                  />
                ))}
              </SortableContext>
            </tbody>
          </table>
          </DndContext>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}

      {(settingsRef || creating) && (
        <MenuSettingsDialog
          menuRef={settingsRef ?? undefined}
          onClose={() => { setSettingsRef(null); setCreating(false) }}
          onSaved={() => { setSettingsRef(null); setCreating(false); loadMenus() }}
        />
      )}
    </div>
  )
}

function SortableMenuRow({ m, filter, tdStyle, onOpen, onSettings, onClone, onVisible, onArchive, onDelete }: {
  m: Menu
  filter: FilterType
  tdStyle: React.CSSProperties
  onOpen: () => void
  onSettings: () => void
  onClone: () => void
  onVisible: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: m.reference })
  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    borderTop: '1px solid #f5f5f5',
    background: isDragging ? '#f5f6ff' : undefined,
    boxShadow: isDragging ? '0 4px 12px rgba(0,0,0,0.08)' : undefined,
  }
  const clickCell: React.CSSProperties = { ...tdStyle, cursor: 'pointer' }
  return (
    <tr ref={setNodeRef} style={rowStyle}>
      <td style={{ ...tdStyle, textAlign: 'center', cursor: 'grab', touchAction: 'none', color: '#bbb' }}
        {...attributes} {...listeners} onClick={e => e.stopPropagation()} title="Drag to reorder">⋮⋮</td>
      <td style={{ ...clickCell, fontWeight: 600 }} onClick={onOpen}>{m.name}</td>
      <td style={clickCell} onClick={onOpen}>{fmtItems(m.itemCount)}</td>
      <td style={clickCell} onClick={onOpen}>{fmtLeadTime(m.leadTimeHours)}</td>
      <td style={clickCell} onClick={onOpen}>{fmtServiceTypes(m.serviceTypes)}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
          <button
            onClick={onSettings}
            style={{
              background: BLUE, color: '#fff', border: 'none',
              borderRadius: 20, padding: '7px 14px',
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
              fontFamily: F, display: 'inline-flex', alignItems: 'center', gap: 6,
              whiteSpace: 'nowrap',
            }}
          >
            <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>⚙</span>
            Menu Settings
          </button>
          <ActionBtn title="Clone" onClick={onClone}>⧉</ActionBtn>
          {filter !== 'ARCHIVED' && (
            <ActionBtn title={m.visible ? 'Hide' : 'Show'} onClick={onVisible}>
              {m.visible ? '👁' : '🚫'}
            </ActionBtn>
          )}
          <ActionBtn title={m.archived ? 'Unarchive' : 'Archive'} onClick={onArchive}>
            {m.archived ? '↩' : '🗄'}
          </ActionBtn>
          <ActionBtn title="Delete" red onClick={onDelete}>✕</ActionBtn>
        </div>
      </td>
    </tr>
  )
}

function ActionBtn({ children, onClick, title, red }: { children: React.ReactNode; onClick: () => void; title?: string; red?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: red ? '#FEF2F2' : '#f5f5f8',
        border: `1px solid ${red ? '#FECACA' : '#e8e8ee'}`,
        borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer',
        color: red ? '#E53935' : '#555', fontFamily: F,
      }}
    >
      {children}
    </button>
  )
}
