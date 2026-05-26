'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const IMG_BASE = 'https://api.familymeal.com/public-api/images'

// ─── Constants ────────────────────────────────────────────────────────────────

const PKG_TYPES = [
  { value: 'FAMILY_MEAL', label: 'Family Meal' },
  { value: 'KITS', label: 'Kits' },
  { value: 'BEVERAGES', label: 'Beverages' },
  { value: 'PANTRY', label: 'Pantry' },
  { value: 'CHEFS_TABLE', label: "Chef's Table" },
  { value: 'POPUP', label: 'Pop Up' },
  { value: 'COLLABS', label: 'Collabs' },
  { value: 'DRINKS', label: 'Drinks' },
  { value: 'SERIES', label: 'Series' },
]

const PREP_TIMES = [0, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const PREP_DAYS = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28]
const HOURS = ['01','02','03','04','05','06','07','08','09','10','11','12']
const MINUTES = ['00','15','30','45']
const DAYS_OF_WEEK = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'] as const

type DayKey = typeof DAYS_OF_WEEK[number]

interface DaySelect {
  [key: string]: boolean
}

interface Group {
  reference: string
  name: string
  externalName?: string
}

interface GroupToggle {
  reference: string
  name: string
  externalName?: string
  enabled: boolean
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MealPackageFormProps {
  menuRef: string
  categoryRef: string
  pkgRef?: string
  mode: 'create' | 'edit'
  onSave: (payload: Record<string, unknown>) => Promise<void>
  onCancel: () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MealPackageForm({ menuRef, categoryRef, pkgRef, mode, onSave, onCancel }: MealPackageFormProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Basic Info ──
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('')
  const [price, setPrice] = useState('')
  const [displayPrice, setDisplayPrice] = useState('')
  const [serves, setServes] = useState('')
  const [minQuantity, setMinQuantity] = useState('')

  // ── Image ──
  const [imageRef, setImageRef] = useState('')
  const [imagePreview, setImagePreview] = useState('')
  const [uploading, setUploading] = useState(false)

  // ── Dietary ──
  const [allowedSpecialInstructions, setAllowedSpecialInstructions] = useState(false)
  const [vegetarian, setVegetarian] = useState(false)
  const [containsNuts, setContainsNuts] = useState(false)
  const [glutenFree, setGlutenFree] = useState(false)
  const [vegan, setVegan] = useState(false)
  const [containsAlcohol, setContainsAlcohol] = useState(false)

  // ── Availability ──
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [prepTime, setPrepTime] = useState(0)
  const [prepDays, setPrepDays] = useState(1)
  const [inventoryPerDay, setInventoryPerDay] = useState(100)
  const [maxOrder, setMaxOrder] = useState(100)
  const [inheritSchedule, setInheritSchedule] = useState(true)
  const [isSameDay, setIsSameDay] = useState<'enabled' | 'disabled'>('enabled')
  const [sameDaysTimeFrom, setSameDaysTimeFrom] = useState('09')
  const [sameDaysMinutesFrom, setSameDaysMinutesFrom] = useState('00')
  const [sameDaysMeridiemFrom, setSameDaysMeridiemFrom] = useState('AM')
  const [sameDaysTimeTo, setSameDaysTimeTo] = useState('09')
  const [sameDaysMinutesTo, setSameDaysMinutesTo] = useState('00')
  const [sameDaysMeridiemTo, setSameDaysMeridiemTo] = useState('PM')
  const [cutOffType, setCutOffType] = useState<'NO' | 'DAILY' | 'BY_DATE'>('NO')
  const [cutOffTimeFrom, setCutOffTimeFrom] = useState('05')
  const [cutOffMinutesFrom, setCutOffMinutesFrom] = useState('00')
  const [cutOffMeridiem, setCutOffMeridiem] = useState('PM')
  const [cutOffDate, setCutOffDate] = useState('')
  const [daySelect, setDaySelect] = useState<DaySelect>(
    Object.fromEntries(DAYS_OF_WEEK.map(d => [d, true]))
  )

  // ── Groups ──
  const [groups, setGroups] = useState<GroupToggle[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)

  // ── UI ──
  const [loading, setLoading] = useState(mode === 'edit')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [menuName, setMenuName] = useState('')
  const [categoryName, setCategoryName] = useState('')

  // Load menu/category names
  useEffect(() => {
    async function loadNames() {
      for (const filter of ['ACTIVE', 'NON_VISIBLE', 'ARCHIVED']) {
        try {
          const res = await fetch(`/api/restaurant/menus?filter=${filter}&page=0&size=200`)
          if (res.ok) {
            const d = await res.json()
            const menu = (d.content || []).find((m: { reference: string; name: string }) => m.reference === menuRef)
            if (menu) { setMenuName(menu.name); break }
          }
        } catch {}
      }
      try {
        const res = await fetch(`/api/restaurant/categories?menuReference=${menuRef}`)
        if (res.ok) {
          const data = await res.json()
          const cats = Array.isArray(data) ? data : (data.content || [])
          const cat = cats.find((c: { reference: string; name: string }) => c.reference === categoryRef)
          if (cat) setCategoryName(cat.name)
        }
      } catch {}
    }
    loadNames()
  }, [menuRef, categoryRef])

  // Load groups
  useEffect(() => {
    async function loadGroups() {
      setLoadingGroups(true)
      try {
        const res = await fetch('/api/restaurant/groups/list')
        if (res.ok) {
          const data = await res.json()
          const list: Group[] = data.content || data || []
          setGroups(list.map(g => ({ reference: g.reference, name: g.name, externalName: g.externalName, enabled: false })))
        }
      } finally { setLoadingGroups(false) }
    }
    loadGroups()
  }, [])

  // Load existing package for edit
  useEffect(() => {
    if (mode !== 'edit' || !pkgRef) return
    async function loadPkg() {
      setLoading(true)
      try {
        const res = await fetch(`/api/restaurant/meal-packages/${pkgRef}`)
        if (!res.ok) return
        const d = await res.json()
        setName(d.name || '')
        setDescription(d.description || '')
        setType(d.type || '')
        setPrice(d.price != null ? String(d.price) : '')
        setDisplayPrice(d.displayPrice || '')
        setServes(d.serves || '')
        setMinQuantity(d.minQuantity != null ? String(d.minQuantity) : '')
        if (d.image?.reference) {
          setImageRef(d.image.reference)
          setImagePreview(`${IMG_BASE}/${d.image.reference}/download?size=400`)
        }
        setAllowedSpecialInstructions(!!d.allowedSpecialInstructions)
        setVegetarian(!!d.vegetarian)
        setContainsNuts(!!d.containsNuts)
        setGlutenFree(!!d.glutenFree)
        setVegan(!!d.vegan)
        setContainsAlcohol(!!d.containsAlcohol)
        if (d.from) setFrom(typeof d.from === 'string' ? d.from.split('T')[0] : '')
        if (d.to) setTo(typeof d.to === 'string' ? d.to.split('T')[0] : '')
        if (d.prepTime != null) setPrepTime(d.prepTime)
        if (d.prepDays != null) setPrepDays(d.prepDays)
        if (d.inventoryPerDay != null) setInventoryPerDay(d.inventoryPerDay)
        if (d.maxOrder != null) setMaxOrder(d.maxOrder)
        if (d.inheritScheduleOptionFromRestaurant != null) setInheritSchedule(d.inheritScheduleOptionFromRestaurant)
        if (d.isSameDay != null) setIsSameDay(d.isSameDay ? 'enabled' : 'disabled')
        if (d.sameDaysTimeFrom) setSameDaysTimeFrom(d.sameDaysTimeFrom)
        if (d.sameDaysMinutesFrom) setSameDaysMinutesFrom(d.sameDaysMinutesFrom)
        if (d.sameDaysMeridiemFrom) setSameDaysMeridiemFrom(d.sameDaysMeridiemFrom)
        if (d.sameDaysTimeTo) setSameDaysTimeTo(d.sameDaysTimeTo)
        if (d.sameDaysMinutesTo) setSameDaysMinutesTo(d.sameDaysMinutesTo)
        if (d.sameDaysMeridiemTo) setSameDaysMeridiemTo(d.sameDaysMeridiemTo)
        if (d.cutOffDate) { setCutOffType('BY_DATE'); setCutOffDate(d.cutOffDate.split('T')[0]) }
        else if (d.cutOffTimeFrom) { setCutOffType('DAILY'); setCutOffTimeFrom(d.cutOffTimeFrom); setCutOffMinutesFrom(d.cutOffMinutesFrom || '00'); setCutOffMeridiem(d.cutOffMeridiem || 'PM') }
        if (d.daySelect) setDaySelect(d.daySelect)
        // Merge existing group settings
        if (d.extraItemsGroups?.length) {
          setGroups(prev => prev.map(g => {
            const existing = d.extraItemsGroups.find((eg: { reference: string; enabled: boolean }) => eg.reference === g.reference)
            return existing ? { ...g, enabled: !!existing.enabled } : g
          }))
        }
      } finally { setLoading(false) }
    }
    loadPkg()
  }, [mode, pkgRef])

  // ── Image upload ──
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/restaurant/images', { method: 'POST', body: fd })
      if (res.ok) {
        const data = await res.json()
        const ref = data.reference || data.id || ''
        setImageRef(ref)
        setImagePreview(ref ? `${IMG_BASE}/${ref}/download?size=400` : URL.createObjectURL(file))
      }
    } finally { setUploading(false) }
  }

  // ── Submit ──
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('Name is required.'); return }
    if (!price) { setError('Price is required.'); return }
    if (!serves.trim()) { setError('Serves is required.'); return }

    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim(),
      type,
      itemCategoryReference: categoryRef,
      price: parseFloat(price),
      displayPrice: displayPrice.trim() || undefined,
      serves: serves.trim(),
      minQuantity: minQuantity ? parseInt(minQuantity) : undefined,
      allowedSpecialInstructions,
      vegetarian,
      containsNuts,
      glutenFree,
      vegan,
      containsAlcohol,
      available: true,
      prepTime,
      prepDays,
      from: from || undefined,
      to: to || undefined,
      inventoryPerDay,
      maxOrder,
      isSameDay: isSameDay === 'enabled',
      sameDaysTimeFrom,
      sameDaysMinutesFrom,
      sameDaysMeridiemFrom,
      sameDaysTimeTo,
      sameDaysMinutesTo,
      sameDaysMeridiemTo,
      inheritScheduleOptionFromRestaurant: inheritSchedule,
      daySelect: inheritSchedule ? undefined : daySelect,
      extraItemsGroups: groups.map(g => ({ reference: g.reference, enabled: g.enabled })),
    }

    if (cutOffType === 'DAILY') {
      payload.cutOffTimeFrom = cutOffTimeFrom
      payload.cutOffMinutesFrom = cutOffMinutesFrom
      payload.cutOffMeridiem = cutOffMeridiem
    } else if (cutOffType === 'BY_DATE') {
      payload.cutOffDate = cutOffDate
    }

    if (imageRef) payload.image = { reference: imageRef }

    setSaving(true)
    try {
      await onSave(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  // ── Styles ──
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F,
    border: '1px solid #ddd', borderRadius: 8, color: DARK,
    background: '#fff', outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6,
  }
  const sectionStyle: React.CSSProperties = {
    background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '24px 28px', marginBottom: 20,
  }
  const sectionTitleStyle: React.CSSProperties = {
    fontSize: 15, fontWeight: 700, color: DARK, margin: '0 0 20px',
  }
  const checkStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: DARK, cursor: 'pointer', userSelect: 'none',
  }

  if (loading) {
    return (
      <div style={{ padding: '28px 32px', fontFamily: F }}>
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 760 }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: '#999', marginBottom: 20 }}>
        <Link href="/restaurant/manage-v2/menus" style={{ color: BLUE, textDecoration: 'none' }}>Menus</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <Link href={`/restaurant/manage-v2/${menuRef}`} style={{ color: BLUE, textDecoration: 'none' }}>{menuName || menuRef}</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <Link href={`/restaurant/manage-v2/${menuRef}/${categoryRef}`} style={{ color: BLUE, textDecoration: 'none' }}>{categoryName || categoryRef}</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span>{mode === 'create' ? 'New Item' : 'Edit Item'}</span>
      </div>

      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 24px' }}>
        {mode === 'create' ? 'Add New Item' : 'Edit Item'}
      </h1>

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#E53935', marginBottom: 20 }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>

        {/* ── Section 1: Basic Info ── */}
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Basic Info</h2>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Name <span style={{ color: '#E53935' }}>*</span></label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={100}
              style={inputStyle}
              required
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={2000}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
            />
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 4, textAlign: 'right' }}>{description.length}/2000</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={labelStyle}>Type</label>
              <select value={type} onChange={e => setType(e.target.value)} style={inputStyle}>
                <option value="">Select a type…</option>
                {PKG_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Price <span style={{ color: '#E53935' }}>*</span></label>
              <input
                type="text"
                value={price}
                onChange={e => setPrice(e.target.value)}
                placeholder="0.00"
                pattern="^[0-9.,]+$"
                style={inputStyle}
                required
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={labelStyle}>Display Price <span style={{ color: '#aaa', fontWeight: 400 }}>(optional)</span></label>
              <input
                type="text"
                value={displayPrice}
                onChange={e => setDisplayPrice(e.target.value)}
                placeholder='e.g. "Starting at $45"'
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Serves <span style={{ color: '#E53935' }}>*</span></label>
              <input
                type="text"
                value={serves}
                onChange={e => setServes(e.target.value)}
                placeholder='e.g. "Serves 4-6"'
                style={inputStyle}
                required
              />
            </div>
          </div>

          <div style={{ maxWidth: 200 }}>
            <label style={labelStyle}>Min Quantity <span style={{ color: '#aaa', fontWeight: 400 }}>(optional)</span></label>
            <input
              type="number"
              value={minQuantity}
              onChange={e => setMinQuantity(e.target.value)}
              min={1}
              style={inputStyle}
            />
          </div>
        </div>

        {/* ── Section 2: Image ── */}
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Image</h2>

          {imagePreview && (
            <div style={{ marginBottom: 16 }}>
              <img
                src={imagePreview}
                alt="Preview"
                style={{ width: 160, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid #eee', display: 'block' }}
              />
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            style={{
              background: uploading ? '#f0f0f4' : '#f5f5f8',
              border: '1px solid #ddd', borderRadius: 8,
              padding: '9px 18px', fontSize: 13, cursor: uploading ? 'not-allowed' : 'pointer',
              fontFamily: F, color: uploading ? '#aaa' : '#555',
            }}
          >
            {uploading ? 'Uploading…' : imagePreview ? 'Replace Image' : 'Upload Image'}
          </button>
          {imageRef && <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>Image ref: {imageRef}</div>}
        </div>

        {/* ── Section 3: Dietary & Options ── */}
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Dietary & Options</h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={checkStyle}>
              <input type="checkbox" checked={allowedSpecialInstructions} onChange={e => setAllowedSpecialInstructions(e.target.checked)} style={{ accentColor: BLUE }} />
              Allow Special Instructions
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={vegetarian} onChange={e => setVegetarian(e.target.checked)} style={{ accentColor: BLUE }} />
              Vegetarian
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={containsNuts} onChange={e => setContainsNuts(e.target.checked)} style={{ accentColor: BLUE }} />
              Contains Nuts
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={glutenFree} onChange={e => setGlutenFree(e.target.checked)} style={{ accentColor: BLUE }} />
              Gluten Free
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={vegan} onChange={e => setVegan(e.target.checked)} style={{ accentColor: BLUE }} />
              Vegan
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={containsAlcohol} onChange={e => setContainsAlcohol(e.target.checked)} style={{ accentColor: BLUE }} />
              Contains Alcohol
            </label>
          </div>
        </div>

        {/* ── Section 4: Availability ── */}
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Availability (Advanced Settings)</h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={labelStyle}>Available From</label>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Available To</label>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} min={from} style={inputStyle} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={labelStyle}>Prep Time (hours)</label>
              <select value={prepTime} onChange={e => setPrepTime(Number(e.target.value))} style={inputStyle}>
                {PREP_TIMES.map(t => <option key={t} value={t}>{t === 0 ? '0' : t < 1 ? `${t * 60} min` : `${t} hr`}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Prep Days</label>
              <select value={prepDays} onChange={e => setPrepDays(Number(e.target.value))} style={inputStyle}>
                {PREP_DAYS.map(d => <option key={d} value={d}>{d} {d === 1 ? 'day' : 'days'}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={labelStyle}>Inventory Per Day <span style={{ color: '#E53935' }}>*</span></label>
              <input
                type="number"
                value={inventoryPerDay}
                onChange={e => setInventoryPerDay(Number(e.target.value))}
                min={1}
                style={inputStyle}
                required
              />
            </div>
            <div>
              <label style={labelStyle}>Max Order <span style={{ color: '#E53935' }}>*</span></label>
              <input
                type="number"
                value={maxOrder}
                onChange={e => setMaxOrder(Number(e.target.value))}
                min={1}
                style={inputStyle}
                required
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={checkStyle}>
              <input type="checkbox" checked={inheritSchedule} onChange={e => setInheritSchedule(e.target.checked)} style={{ accentColor: BLUE }} />
              Inherit Schedule from Restaurant
            </label>
          </div>

          {/* Per-day availability (only when not inheriting) */}
          {!inheritSchedule && (
            <div style={{ marginBottom: 16, padding: '16px', background: '#fafafa', borderRadius: 8, border: '1px solid #eee' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 12 }}>Available Days</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {DAYS_OF_WEEK.map(day => (
                  <label key={day} style={checkStyle}>
                    <input
                      type="checkbox"
                      checked={!!daySelect[day]}
                      onChange={e => setDaySelect(prev => ({ ...prev, [day]: e.target.checked }))}
                      style={{ accentColor: BLUE }}
                    />
                    {day.charAt(0).toUpperCase() + day.slice(1, 3)}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Same Day Ordering */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 8 }}>Same Day Ordering</div>
            <div style={{ display: 'flex', gap: 20 }}>
              <label style={checkStyle}>
                <input type="radio" name="sameDay" value="enabled" checked={isSameDay === 'enabled'} onChange={() => setIsSameDay('enabled')} style={{ accentColor: BLUE }} />
                Enabled
              </label>
              <label style={checkStyle}>
                <input type="radio" name="sameDay" value="disabled" checked={isSameDay === 'disabled'} onChange={() => setIsSameDay('disabled')} style={{ accentColor: BLUE }} />
                Disabled
              </label>
            </div>
          </div>

          {isSameDay === 'enabled' && (
            <div style={{ marginBottom: 16, padding: '16px', background: '#fafafa', borderRadius: 8, border: '1px solid #eee' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 12 }}>Same Day Window</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={{ ...labelStyle, marginBottom: 4 }}>From</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select value={sameDaysTimeFrom} onChange={e => setSameDaysTimeFrom(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                      {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <span style={{ color: '#aaa' }}>:</span>
                    <select value={sameDaysMinutesFrom} onChange={e => setSameDaysMinutesFrom(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                      {MINUTES.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <select value={sameDaysMeridiemFrom} onChange={e => setSameDaysMeridiemFrom(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                      <option value="AM">AM</option><option value="PM">PM</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ ...labelStyle, marginBottom: 4 }}>To</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select value={sameDaysTimeTo} onChange={e => setSameDaysTimeTo(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                      {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <span style={{ color: '#aaa' }}>:</span>
                    <select value={sameDaysMinutesTo} onChange={e => setSameDaysMinutesTo(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                      {MINUTES.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <select value={sameDaysMeridiemTo} onChange={e => setSameDaysMeridiemTo(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                      <option value="AM">AM</option><option value="PM">PM</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Cut-off */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 8 }}>Cut-off Type</div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {(['NO', 'DAILY', 'BY_DATE'] as const).map(opt => (
                <label key={opt} style={checkStyle}>
                  <input type="radio" name="cutOffType" value={opt} checked={cutOffType === opt} onChange={() => setCutOffType(opt)} style={{ accentColor: BLUE }} />
                  {opt === 'NO' ? 'No Cut-off' : opt === 'DAILY' ? 'Daily Cut-off' : 'By Date'}
                </label>
              ))}
            </div>
          </div>

          {cutOffType === 'DAILY' && (
            <div style={{ marginBottom: 16, padding: '16px', background: '#fafafa', borderRadius: 8, border: '1px solid #eee' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 10 }}>Daily Cut-off Time</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select value={cutOffTimeFrom} onChange={e => setCutOffTimeFrom(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                  {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <span style={{ color: '#aaa' }}>:</span>
                <select value={cutOffMinutesFrom} onChange={e => setCutOffMinutesFrom(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                  {MINUTES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <select value={cutOffMeridiem} onChange={e => setCutOffMeridiem(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                  <option value="AM">AM</option><option value="PM">PM</option>
                </select>
              </div>
            </div>
          )}

          {cutOffType === 'BY_DATE' && (
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Cut-off Date</label>
              <input type="date" value={cutOffDate} onChange={e => setCutOffDate(e.target.value)} style={{ ...inputStyle, maxWidth: 220 }} />
            </div>
          )}
        </div>

        {/* ── Section 5: Modifier Groups ── */}
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Modifier Groups</h2>

          {loadingGroups ? (
            <div style={{ color: '#aaa', fontSize: 13 }}>Loading groups…</div>
          ) : groups.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 13 }}>
              No modifier groups found.{' '}
              <Link href="/restaurant/manage/groups" style={{ color: BLUE }}>Create groups</Link> first.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {groups.map(group => (
                <label
                  key={group.reference}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', border: `1px solid ${group.enabled ? BLUE : '#eee'}`,
                    borderRadius: 8, cursor: 'pointer', background: group.enabled ? '#EEF2FF' : '#fff',
                    transition: 'all 0.15s',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={group.enabled}
                    onChange={e => setGroups(prev => prev.map(g => g.reference === group.reference ? { ...g, enabled: e.target.checked } : g))}
                    style={{ accentColor: BLUE, width: 15, height: 15 }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>{group.name}</div>
                    {group.externalName && <div style={{ fontSize: 11, color: '#888' }}>{group.externalName}</div>}
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* ── Actions ── */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              background: saving ? '#aaa' : BLUE, color: '#fff', border: 'none',
              borderRadius: 8, padding: '11px 28px', fontSize: 13, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F,
            }}
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Create Item' : 'Save Changes'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'transparent', border: '1px solid #ddd', borderRadius: 8,
              padding: '11px 22px', fontSize: 13, cursor: 'pointer', fontFamily: F, color: '#666',
            }}
          >
            Cancel
          </button>
        </div>

      </form>
    </div>
  )
}
