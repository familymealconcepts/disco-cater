'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
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
}

type FilterType = 'ACTIVE' | 'NON_VISIBLE' | 'ARCHIVED'

const TABS: { label: string; filter: FilterType }[] = [
  { label: 'Active Menus', filter: 'ACTIVE' },
  { label: 'Inactive Menus', filter: 'NON_VISIBLE' },
  { label: 'Archived Menus', filter: 'ARCHIVED' },
]

const TYPE_LABELS: Record<string, string> = {
  FAMILY_MEAL: 'Family Meal', KITS: 'Kits', BEVERAGES: 'Beverages',
  PANTRY: 'Pantry', CHEFS_TABLE: "Chef's Table", POPUP: 'Pop Up',
  COLLABS: 'Collabs', DRINKS: 'Drinks', SERIES: 'Series',
}

function formatDate(d: string) {
  if (!d) return '—'
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return d }
}

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

  const filter = TABS[activeTab].filter

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
          onClick={() => router.push('/restaurant/manage-v2/add-new-menu/settings')}
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
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fafafa' }}>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Start Date</th>
                <th style={thStyle}>End Date</th>
                <th style={thStyle}>Image</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {menus.map((m, i) => (
                <tr
                  key={m.reference}
                  style={{ borderTop: i > 0 ? '1px solid #f5f5f5' : undefined, cursor: 'pointer' }}
                  onClick={() => router.push(`/restaurant/manage-v2/${m.reference}`)}
                >
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{m.name}</td>
                  <td style={tdStyle}>{TYPE_LABELS[m.menuType] || m.menuType || '—'}</td>
                  <td style={tdStyle}>{formatDate(m.startDate)}</td>
                  <td style={tdStyle}>{formatDate(m.endDate)}</td>
                  <td style={tdStyle}>
                    {m.image?.reference ? (
                      <img
                        src={`https://api.familymeal.com/public-api/images/${m.image.reference}/download?size=70`}
                        alt=""
                        style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid #eee' }}
                      />
                    ) : (
                      <div style={{ width: 40, height: 40, background: '#f0f0f4', borderRadius: 6, border: '1px solid #eee' }} />
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                      <button
                        onClick={() => setSettingsRef(m.reference)}
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
                      <ActionBtn title="Clone" onClick={() => handleClone(m.reference)}>⧉</ActionBtn>
                      {filter !== 'ARCHIVED' && (
                        <ActionBtn title={m.visible ? 'Hide' : 'Show'} onClick={() => handleVisible(m.reference, m.visible)}>
                          {m.visible ? '👁' : '🚫'}
                        </ActionBtn>
                      )}
                      <ActionBtn title={m.archived ? 'Unarchive' : 'Archive'} onClick={() => handleArchive(m.reference, m.archived)}>
                        {m.archived ? '↩' : '🗄'}
                      </ActionBtn>
                      <ActionBtn title="Delete" red onClick={() => handleDelete(m.reference, m.name)}>✕</ActionBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}

      {settingsRef && (
        <MenuSettingsDialog
          menuRef={settingsRef}
          onClose={() => setSettingsRef(null)}
          onSaved={() => { setSettingsRef(null); loadMenus() }}
        />
      )}
    </div>
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
