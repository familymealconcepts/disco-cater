'use client'
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

const MENU_TYPES = [
  { value: 'GENERAL_CATERING', label: 'General Catering' },
  { value: 'OFFICE_CATERING', label: 'Office Catering' },
  { value: 'HOLIDAY_CATERING', label: 'Holiday Catering' },
  { value: 'MEAL_PREP', label: 'Meal Prep' },
  { value: 'PRIVATE_CHEF', label: 'Private Chef' },
  { value: 'NATIONWIDE_SHIPPING', label: 'Nationwide Shipping' },
  { value: 'MERCH', label: 'Merch' },
  { value: 'POP_UP', label: 'Pop Up' },
]

export default function EditMenuSettingsPage() {
  const router = useRouter()
  const params = useParams<{ menuRef: string }>()
  const menuRef = params.menuRef

  const [name, setName] = useState('')
  const [menuType, setMenuType] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [visible, setVisible] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/restaurant/menus?filter=ACTIVE&page=0&size=200`)
        // Try to find the menu in all filters
        let menu = null
        if (res.ok) {
          const d = await res.json()
          menu = (d.content || []).find((m: { reference: string }) => m.reference === menuRef)
        }
        if (!menu) {
          // Try NON_VISIBLE and ARCHIVED
          for (const filter of ['NON_VISIBLE', 'ARCHIVED']) {
            const r2 = await fetch(`/api/restaurant/menus?filter=${filter}&page=0&size=200`)
            if (r2.ok) {
              const d2 = await r2.json()
              menu = (d2.content || []).find((m: { reference: string }) => m.reference === menuRef)
              if (menu) break
            }
          }
        }
        if (menu) {
          setName(menu.name || '')
          setMenuType(menu.menuType || '')
          setStartDate(menu.startDate || '')
          setEndDate(menu.endDate || '')
          setVisible(menu.visible ?? true)
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [menuRef])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('Name is required.'); return }
    if (!menuType) { setError('Menu Type is required.'); return }
    if (!startDate) { setError('Start Date is required.'); return }
    if (!endDate) { setError('End Date is required.'); return }
    setSaving(true)
    try {
      const res = await fetch(`/api/restaurant/menus/${menuRef}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), menuType, startDate, endDate, visible }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to update menu.')
        return
      }
      router.push(`/restaurant/manage-v2/${menuRef}`)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F,
    border: '1px solid #ddd', borderRadius: 8, color: DARK,
    background: '#fff', outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6,
  }

  if (loading) {
    return (
      <div style={{ padding: '28px 32px', fontFamily: F }}>
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 640 }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: '#999', marginBottom: 20 }}>
        <Link href="/restaurant/manage-v2/menus" style={{ color: BLUE, textDecoration: 'none' }}>Menus</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <Link href={`/restaurant/manage-v2/${menuRef}`} style={{ color: BLUE, textDecoration: 'none' }}>Menu Detail</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span>Settings</span>
      </div>

      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 28px' }}>Edit Menu Settings</h1>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '28px 32px' }}>
        <form onSubmit={handleSubmit}>
          {error && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#E53935', marginBottom: 20 }}>
              {error}
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Name <span style={{ color: '#E53935' }}>*</span></label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              style={inputStyle}
              required
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Menu Type <span style={{ color: '#E53935' }}>*</span></label>
            <select value={menuType} onChange={e => setMenuType(e.target.value)} style={inputStyle} required>
              <option value="">Select a type…</option>
              {MENU_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div>
              <label style={labelStyle}>Start Date <span style={{ color: '#E53935' }}>*</span></label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                style={inputStyle}
                required
              />
            </div>
            <div>
              <label style={labelStyle}>End Date <span style={{ color: '#E53935' }}>*</span></label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                min={startDate}
                style={inputStyle}
                required
              />
            </div>
          </div>

          <div style={{ marginBottom: 28 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: DARK }}>
              <input
                type="checkbox"
                checked={visible}
                onChange={e => setVisible(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: BLUE }}
              />
              Visible (show this menu to customers)
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="submit"
              disabled={saving}
              style={{
                background: saving ? '#aaa' : BLUE, color: '#fff', border: 'none',
                borderRadius: 8, padding: '10px 24px', fontSize: 13, fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F,
              }}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/restaurant/manage-v2/${menuRef}`)}
              style={{
                background: 'transparent', border: '1px solid #ddd', borderRadius: 8,
                padding: '10px 20px', fontSize: 13, cursor: 'pointer', fontFamily: F, color: '#666',
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
