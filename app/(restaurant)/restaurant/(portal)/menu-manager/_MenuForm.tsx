'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TimeSelect, normalizeTime } from '../_components/TimeSelect'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

// FM MenuType (8) with display labels.
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

// Day pills in FM's Su–Sa order.
const DAYS: { key: string; label: string }[] = [
  { key: 'SUNDAY', label: 'Su' }, { key: 'MONDAY', label: 'Mo' }, { key: 'TUESDAY', label: 'Tu' },
  { key: 'WEDNESDAY', label: 'We' }, { key: 'THURSDAY', label: 'Th' }, { key: 'FRIDAY', label: 'Fr' },
  { key: 'SATURDAY', label: 'Sa' },
]

function slugify(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
}

type Win = { from: string; to: string }
const DEFAULT_PERDAY = (): Record<string, Win> =>
  Object.fromEntries(DAYS.map(d => [d.key, { from: '11:00', to: '19:00' }]))

export default function MenuForm({ menuRef }: { menuRef?: string }) {
  const router = useRouter()
  const isEdit = !!menuRef

  const [name, setName] = useState('')
  const [type, setType] = useState('GENERAL_CATERING')
  const [url, setUrl] = useState('')
  const [urlDirty, setUrlDirty] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [visible, setVisible] = useState(true)

  const [availabilityMode, setAvailabilityMode] = useState<'ALWAYS' | 'CUSTOM'>('ALWAYS')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const [scheduleType, setScheduleType] = useState<'SAME_DAY' | 'CUSTOM'>('SAME_DAY')
  const [enabledDays, setEnabledDays] = useState<Record<string, boolean>>(
    () => Object.fromEntries(DAYS.map(d => [d.key, ['SATURDAY', 'SUNDAY'].includes(d.key) ? false : true])),
  )
  const [sameFrom, setSameFrom] = useState('11:00')
  const [sameTo, setSameTo] = useState('19:00')
  const [perDay, setPerDay] = useState<Record<string, Win>>(DEFAULT_PERDAY)

  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Live slug preview from the name until the user edits the slug field.
  const effectiveSlug = urlDirty ? url : slugify(name)

  // ── Load (edit) ──
  useEffect(() => {
    if (!menuRef) return
    ;(async () => {
      try {
        const res = await fetch(`/api/restaurant/disco-menus/${menuRef}`)
        const d = res.ok ? (await res.json()).menu : null
        if (!d) { setError('Menu not found.'); return }
        setName(d.name || '')
        setType(d.type || 'GENERAL_CATERING')
        setUrl(d.url || ''); setUrlDirty(true)
        setImageUrl(d.image_url || '')
        setVisible(d.visible !== false)
        setAvailabilityMode(d.availability_mode === 'CUSTOM' ? 'CUSTOM' : 'ALWAYS')
        setStartDate(d.start_date || ''); setEndDate(d.end_date || '')
        const sc = d.schedule_config || {}
        setScheduleType(sc.scheduleType === 'CUSTOM' ? 'CUSTOM' : 'SAME_DAY')
        if (Array.isArray(sc.days)) {
          setEnabledDays(Object.fromEntries(DAYS.map(x => [x.key, sc.days.includes(x.key)])))
        }
        if (sc.sameWindow) { setSameFrom(normalizeTime(sc.sameWindow.from) || '11:00'); setSameTo(normalizeTime(sc.sameWindow.to) || '19:00') }
        if (sc.perDay && typeof sc.perDay === 'object') {
          const pd = DEFAULT_PERDAY()
          for (const k of Object.keys(pd)) if (sc.perDay[k]) pd[k] = { from: normalizeTime(sc.perDay[k].from) || '11:00', to: normalizeTime(sc.perDay[k].to) || '19:00' }
          setPerDay(pd)
        }
      } finally { setLoading(false) }
    })()
  }, [menuRef])

  async function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { setError('Image is too large (max 5MB).'); return }
    setUploading(true); setError('')
    try {
      const fd = new FormData(); fd.append('image', file)
      const res = await fetch('/api/become-a-partner/logo', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.url) setImageUrl(String(data.url))
      else setError(data?.error || 'Could not upload image.')
    } finally { setUploading(false) }
  }

  function toggleDay(k: string) { setEnabledDays(s => ({ ...s, [k]: !s[k] })) }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('Menu name is required.'); return }
    if (availabilityMode === 'CUSTOM' && (!startDate || !endDate)) { setError('Custom availability needs a start and end date.'); return }
    const activeDays = DAYS.filter(d => enabledDays[d.key]).map(d => d.key)
    if (activeDays.length === 0) { setError('Select at least one pickup day.'); return }

    const scheduleConfig = {
      scheduleType,
      days: activeDays,
      sameWindow: { from: sameFrom, to: sameTo },
      perDay: Object.fromEntries(activeDays.map(k => [k, perDay[k] || { from: sameFrom, to: sameTo }])),
    }
    const payload = {
      name: name.trim(), type, url: effectiveSlug, urlAuto: !urlDirty,
      imageUrl: imageUrl || undefined, visible,
      availabilityMode, startDate: startDate || undefined, endDate: endDate || undefined,
      scheduleConfig,
    }
    setSaving(true)
    try {
      const res = await fetch(isEdit ? `/api/restaurant/disco-menus/${menuRef}` : '/api/restaurant/disco-menus', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error || 'Could not save menu.'); return }
      const ref = isEdit ? menuRef : (data.reference || '')
      router.push(ref ? `/restaurant/menu-manager/${ref}` : '/restaurant/menu-manager')
    } catch { setError('Network error. Please try again.') } finally { setSaving(false) }
  }

  const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F, border: '1px solid #ddd', borderRadius: 8, color: DARK, background: '#fff', outline: 'none', boxSizing: 'border-box' }
  const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }
  const timeStyle: React.CSSProperties = { ...inputStyle, padding: '8px 8px' }
  const card: React.CSSProperties = { background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '22px 26px', marginBottom: 18 }
  const radioRow = (checked: boolean): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: DARK, cursor: 'pointer', padding: '6px 0' })

  if (loading) return <div style={{ padding: 40, color: '#aaa', fontFamily: F }}>Loading…</div>

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 720 }}>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
        <a href="/restaurant/menu-manager" style={{ color: BLUE, textDecoration: 'none' }}>Menus</a>
        <span style={{ margin: '0 6px' }}>/</span><span>{isEdit ? 'Edit Menu' : 'New Menu'}</span>
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 24px' }}>{isEdit ? 'Edit Menu' : 'Create Menu'}</h1>

      <form onSubmit={save}>
        {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: RED, marginBottom: 16 }}>{error}</div>}

        <div style={card}>
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Menu Name <span style={{ color: RED }}>*</span></label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Summer Catering Menu" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Menu Category <span style={{ color: RED }}>*</span></label>
            <select value={type} onChange={e => setType(e.target.value)} style={inputStyle}>
              {MENU_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Menu URL</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#999' }}>/order/…/</span>
              <input type="text" value={effectiveSlug}
                onChange={e => { setUrl(slugify(e.target.value)); setUrlDirty(true) }}
                placeholder="auto-generated from name" style={{ ...inputStyle, width: 240 }} />
            </div>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Lowercase letters, numbers and hyphens only. Must be unique for your restaurant.</div>
          </div>
          <div>
            <label style={label}>Menu Image</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {imageUrl
                ? <img src={imageUrl} alt="" style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover', border: '1px solid #eee' }} />
                : <div style={{ width: 72, height: 72, borderRadius: 8, background: '#f4f4f8', border: '1px solid #eee' }} />}
              <label style={{ fontSize: 13, color: BLUE, cursor: 'pointer', fontWeight: 600 }}>
                {uploading ? 'Uploading…' : (imageUrl ? 'Replace image' : 'Upload image')}
                <input type="file" accept="image/jpeg,image/png" onChange={handleImage} style={{ display: 'none' }} />
              </label>
            </div>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>.jpg or .png, up to 5MB.</div>
          </div>
        </div>

        {/* Availability */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 10 }}>Menu Availability</div>
          <label style={radioRow(availabilityMode === 'ALWAYS')}>
            <input type="radio" checked={availabilityMode === 'ALWAYS'} onChange={() => setAvailabilityMode('ALWAYS')} style={{ accentColor: BLUE }} /> Always
          </label>
          <label style={radioRow(availabilityMode === 'CUSTOM')}>
            <input type="radio" checked={availabilityMode === 'CUSTOM'} onChange={() => setAvailabilityMode('CUSTOM')} style={{ accentColor: BLUE }} /> Custom (date range)
          </label>
          {availabilityMode === 'CUSTOM' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 10 }}>
              <div><label style={label}>Start Date</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} /></div>
              <div><label style={label}>End Date</label><input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} style={inputStyle} /></div>
            </div>
          )}
        </div>

        {/* Pickup Window (delivery reuses this — FM has no separate delivery window) */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 4 }}>Pickup Window</div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>Delivery orders use the same window.</div>
          <label style={radioRow(scheduleType === 'SAME_DAY')}>
            <input type="radio" checked={scheduleType === 'SAME_DAY'} onChange={() => setScheduleType('SAME_DAY')} style={{ accentColor: BLUE }} /> Same Window per Day
          </label>
          <label style={radioRow(scheduleType === 'CUSTOM')}>
            <input type="radio" checked={scheduleType === 'CUSTOM'} onChange={() => setScheduleType('CUSTOM')} style={{ accentColor: BLUE }} /> Custom per Day
          </label>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
            {DAYS.map(d => (
              <button key={d.key} type="button" onClick={() => toggleDay(d.key)}
                style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F,
                  border: '1.5px solid ' + (enabledDays[d.key] ? BLUE : '#e0e0e0'),
                  background: enabledDays[d.key] ? BLUE : '#fff', color: enabledDays[d.key] ? '#fff' : '#555' }}>{d.label}</button>
            ))}
          </div>

          {scheduleType === 'SAME_DAY' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div><label style={label}>From</label><TimeSelect value={sameFrom} onChange={setSameFrom} style={timeStyle} /></div>
              <div><label style={label}>To</label><TimeSelect value={sameTo} onChange={setSameTo} style={timeStyle} /></div>
            </div>
          ) : (
            <div>
              {DAYS.filter(d => enabledDays[d.key]).length === 0 && <div style={{ fontSize: 12, color: '#aaa' }}>Select at least one day above.</div>}
              {DAYS.filter(d => enabledDays[d.key]).map(d => (
                <div key={d.key} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 1fr', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>{d.label}</div>
                  <TimeSelect value={perDay[d.key]?.from || '11:00'} onChange={v => setPerDay(s => ({ ...s, [d.key]: { ...(s[d.key] || { from: '11:00', to: '19:00' }), from: v } }))} style={timeStyle} />
                  <TimeSelect value={perDay[d.key]?.to || '19:00'} onChange={v => setPerDay(s => ({ ...s, [d.key]: { ...(s[d.key] || { from: '11:00', to: '19:00' }), to: v } }))} style={timeStyle} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Visible */}
        <div style={card}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: DARK }}>
            <input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} style={{ width: 16, height: 16, accentColor: BLUE, cursor: 'pointer' }} />
            Visible (shown to customers)
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="submit" disabled={saving}
            style={{ background: saving ? '#aaa' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '11px 24px', fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}>
            {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Menu')}
          </button>
          <button type="button" onClick={() => router.push('/restaurant/menu-manager')}
            style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '11px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
