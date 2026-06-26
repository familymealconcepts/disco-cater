'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { AddExistingGroupDialog, GroupFormDialog, type LibraryGroup, type AttachedGroup } from './_GroupDialogs'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const IMG_BASE = 'https://api.familymeal.com/public-api/images'

// ─── Constants ────────────────────────────────────────────────────────────────

// Availability scheduling fields are still sent in the save payload (FM needs
// them), but their advanced UI was removed — these days drive the daySelect
// default only.
const DAYS_OF_WEEK = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'] as const

interface DaySelect {
  [key: string]: boolean
}

// LibraryGroup / AttachedGroup come from ./_GroupDialogs.

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

  // ── Groups (modifier groups attached to this meal package) ──
  const [library, setLibrary] = useState<LibraryGroup[]>([])        // all groups in the restaurant's library
  const [attached, setAttached] = useState<AttachedGroup[]>([])     // attached to THIS item, in display order
  const [pkgGroupRefs, setPkgGroupRefs] = useState<{ reference: string; enabled: boolean }[] | null>(null) // raw from package (edit)
  const [loadingGroups, setLoadingGroups] = useState(false)
  // Dialogs
  const [addExistingOpen, setAddExistingOpen] = useState(false)
  const [groupForm, setGroupForm] = useState<{ mode: 'create' | 'edit'; group?: AttachedGroup } | null>(null)
  // Native HTML5 drag reorder (same pattern as the locations page)
  const [draggedRef, setDraggedRef] = useState<string | null>(null)
  const [dragOverRef, setDragOverRef] = useState<string | null>(null)

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

  // Load the restaurant's group library (for "Add Existing" + display details)
  useEffect(() => {
    async function loadGroups() {
      setLoadingGroups(true)
      try {
        const res = await fetch('/api/restaurant/groups/list')
        if (res.ok) {
          const data = await res.json()
          const list: any[] = data.content || data || []
          setLibrary(list.map((g): LibraryGroup => ({
            reference: g.reference,
            name: g.name,
            externalName: g.externalName || '',
            subExternalName: g.subExternalName || '',
            minSelectedItems: g.minSelectedItems ?? 0,
            maxSelectedItems: g.maxSelectedItems ?? 1,
            itemCount: Array.isArray(g.addOns) ? g.addOns.length : 0,
            addOnsReferences: Array.isArray(g.addOns) ? g.addOns.map((a: { reference: string }) => a.reference) : [],
          })))
        }
      } finally { setLoadingGroups(false) }
    }
    loadGroups()
  }, [])

  // Join the package's attached group refs (edit) with the library details, in
  // the package's order. Runs once both are available; create mode starts empty.
  useEffect(() => {
    if (!pkgGroupRefs) return
    if (library.length === 0) return
    setAttached(
      pkgGroupRefs
        .map(({ reference, enabled }) => {
          const lib = library.find(g => g.reference === reference)
          return lib ? { ...lib, enabled } : null
        })
        .filter((g): g is AttachedGroup => g !== null),
    )
  }, [pkgGroupRefs, library])

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
        // Capture attached groups (reference + enabled, in order); the join
        // effect fills in display details once the library has loaded.
        setPkgGroupRefs(
          Array.isArray(d.extraItemsGroups)
            ? d.extraItemsGroups.map((eg: { reference: string; enabled?: boolean }) => ({ reference: eg.reference, enabled: eg.enabled !== false }))
            : [],
        )
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
    // Price OR Display Price is enough — when Price is blank/0 the Display
    // Price string is what shows to the diner.
    if (!price && !displayPrice.trim()) { setError('Enter a Price or a Display Price.'); return }
    if (!serves.trim()) { setError('Serves is required.'); return }

    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim(),
      type,
      itemCategoryReference: categoryRef,
      price: price ? parseFloat(price) : 0,
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
      extraItemsGroups: attached.map(g => ({ reference: g.reference, enabled: g.enabled })),
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

  // ── Group attach / detach / edit / reorder (per-item, persisted via save) ──
  const attachable = library.filter(g => !attached.some(a => a.reference === g.reference))

  function attachGroups(groups: LibraryGroup[]) {
    setAttached(prev => {
      const have = new Set(prev.map(g => g.reference))
      return [...prev, ...groups.filter(g => !have.has(g.reference)).map(g => ({ ...g, enabled: true }))]
    })
    setAddExistingOpen(false)
  }
  function upsertGroup(g: AttachedGroup) {
    setAttached(prev => prev.some(x => x.reference === g.reference) ? prev.map(x => x.reference === g.reference ? g : x) : [...prev, g])
    // Keep the library copy in sync so Add-Existing details stay fresh.
    setLibrary(prev => prev.some(x => x.reference === g.reference)
      ? prev.map(x => x.reference === g.reference ? { reference: g.reference, name: g.name, externalName: g.externalName, subExternalName: g.subExternalName, minSelectedItems: g.minSelectedItems, maxSelectedItems: g.maxSelectedItems, itemCount: g.itemCount, addOnsReferences: g.addOnsReferences } : x)
      : [...prev, { reference: g.reference, name: g.name, externalName: g.externalName, subExternalName: g.subExternalName, minSelectedItems: g.minSelectedItems, maxSelectedItems: g.maxSelectedItems, itemCount: g.itemCount, addOnsReferences: g.addOnsReferences }])
    setGroupForm(null)
  }
  function removeGroup(ref: string) { setAttached(prev => prev.filter(g => g.reference !== ref)) }
  function toggleGroup(ref: string) { setAttached(prev => prev.map(g => g.reference === ref ? { ...g, enabled: !g.enabled } : g)) }

  function onGroupDragStart(e: React.DragEvent, ref: string) {
    setDraggedRef(ref)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', ref) } catch {}
  }
  function onGroupDragOver(e: React.DragEvent, ref: string) {
    e.preventDefault()
    if (ref !== draggedRef && ref !== dragOverRef) setDragOverRef(ref)
  }
  function onGroupDrop(e: React.DragEvent, toRef: string) {
    e.preventDefault()
    const fromRef = draggedRef
    setDraggedRef(null); setDragOverRef(null)
    if (!fromRef || fromRef === toRef) return
    setAttached(prev => {
      const from = prev.findIndex(g => g.reference === fromRef)
      const to = prev.findIndex(g => g.reference === toRef)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }
  function onGroupDragEnd() { setDraggedRef(null); setDragOverRef(null) }

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
  const groupBtnStyle: React.CSSProperties = {
    background: '#fff', border: `1px solid ${BLUE}`, color: BLUE, borderRadius: 8,
    padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: F,
  }
  const thStyle: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '9px 12px', textAlign: 'left', whiteSpace: 'nowrap',
  }
  const tdStyle: React.CSSProperties = { fontSize: 12.5, color: DARK, padding: '10px 12px', verticalAlign: 'middle' }
  const groupIconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#888', padding: '4px 6px' }

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
              <label style={labelStyle}>Price</label>
              <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                <span style={{ display: 'flex', alignItems: 'center', padding: '0 12px', background: '#f5f5f7', color: '#888', fontSize: 13, fontWeight: 600, borderRight: '1px solid #eee' }}>$</span>
                <input
                  type="text"
                  value={price}
                  onChange={e => setPrice(e.target.value)}
                  placeholder="0.00"
                  pattern="^[0-9.,]*$"
                  style={{ ...inputStyle, border: 'none', borderRadius: 0 }}
                />
              </div>
            </div>
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
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
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
            <div>
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
          {imageRef && <div style={{ fontSize: 11, color: '#1D9E75', marginTop: 6 }}>Image attached ✓</div>}
        </div>

        {/* ── Section: Special Instructions ── */}
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Special Instructions</h2>
          <label style={checkStyle}>
            <input type="checkbox" checked={allowedSpecialInstructions} onChange={e => setAllowedSpecialInstructions(e.target.checked)} style={{ accentColor: BLUE }} />
            Allow Special Instructions
          </label>
        </div>

        {/* ── Section 3: Dietary Info ── */}
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Dietary Info</h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
          </div>
        </div>

        {/* ── Section 5: Modifier Groups ── */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ ...sectionTitleStyle, margin: 0 }}>Modifier Groups</h2>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => setAddExistingOpen(true)} style={groupBtnStyle}>+ Add Existing Group</button>
              <button type="button" onClick={() => setGroupForm({ mode: 'create' })} style={groupBtnStyle}>+ Add New Group</button>
            </div>
          </div>

          {loadingGroups && attached.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 13 }}>Loading groups…</div>
          ) : attached.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 13, padding: '4px 0' }}>No groups on this item yet. Use the buttons above to add one.</div>
          ) : (
            <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    <th style={{ ...thStyle, width: 30 }}></th>
                    <th style={thStyle}>Group Name</th>
                    <th style={thStyle}>External</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Items</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Min</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Max</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {attached.map(g => (
                    <tr
                      key={g.reference}
                      onDragOver={e => onGroupDragOver(e, g.reference)}
                      onDrop={e => onGroupDrop(e, g.reference)}
                      onDragEnd={onGroupDragEnd}
                      style={{ borderTop: '1px solid #f0f0f0', background: dragOverRef === g.reference ? '#EEF2FF' : draggedRef === g.reference ? '#f7f7fb' : '#fff' }}
                    >
                      <td draggable onDragStart={e => onGroupDragStart(e, g.reference)} style={{ ...tdStyle, textAlign: 'center', cursor: 'grab', color: '#bbb', userSelect: 'none' }} title="Drag to reorder">⠿</td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{g.name}</td>
                      <td style={{ ...tdStyle, color: '#666' }}>{g.externalName || '—'}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{g.itemCount}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{g.minSelectedItems}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{g.maxSelectedItems}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button type="button" title="Edit group" onClick={() => setGroupForm({ mode: 'edit', group: g })} style={groupIconBtn}>✎</button>
                        <button type="button" title="Remove from item" onClick={() => removeGroup(g.reference)} style={groupIconBtn}>🗑</button>
                        <button type="button" title={g.enabled ? 'Disable on this item' : 'Enable on this item'} onClick={() => toggleGroup(g.reference)}
                          style={{ width: 34, height: 18, borderRadius: 10, border: 'none', background: g.enabled ? BLUE : '#d9d9d9', position: 'relative', cursor: 'pointer', verticalAlign: 'middle', marginLeft: 6 }}>
                          <span style={{ position: 'absolute', top: 2, left: g.enabled ? 18 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

      {/* Group dialogs — rendered outside the form so their buttons never
          submit the meal-package form. */}
      {addExistingOpen && (
        <AddExistingGroupDialog
          candidates={attachable}
          onAdd={attachGroups}
          onClose={() => setAddExistingOpen(false)}
        />
      )}
      {groupForm && (
        <GroupFormDialog
          mode={groupForm.mode}
          initial={groupForm.group}
          onSaved={upsertGroup}
          onClose={() => setGroupForm(null)}
        />
      )}
    </div>
  )
}
