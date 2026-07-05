'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TimeSelect, normalizeTime } from '../_components/TimeSelect'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

// Menu Category (the per-menu `type`) is intentionally dropped as a Disco concept
// — same decision as the FM-backed menus (MenuSettingsDialog FM_MENU_TYPE_DEFAULT).
// The column still exists, so we always store this fixed value; it's never surfaced.
const MENU_TYPE_DEFAULT = 'GENERAL_CATERING'

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

  // Money/timing settings (Stage 5)
  const [offersPickup, setOffersPickup] = useState(true)
  const [offersDelivery, setOffersDelivery] = useState(true)
  const [serviceChargePct, setServiceChargePct] = useState('0')
  const [serviceChargeName, setServiceChargeName] = useState('')
  const [tipDefaultType, setTipDefaultType] = useState<'PERCENTAGE' | 'CUSTOM' | 'NONE'>('PERCENTAGE')
  const [tipDefaultValue, setTipDefaultValue] = useState('15')
  const [pickupOrderMinimum, setPickupOrderMinimum] = useState('0')
  const [deliveryOrderMinimum, setDeliveryOrderMinimum] = useState('0')
  const [maxOrdersPerDay, setMaxOrdersPerDay] = useState('')
  const [leadTimeHours, setLeadTimeHours] = useState('24')
  const [rollingAvailabilityDays, setRollingAvailabilityDays] = useState('90')
  const [dailyCutoffTime, setDailyCutoffTime] = useState('')
  const [hardCutoffDate, setHardCutoffDate] = useState('')
  const [includeUtensils, setIncludeUtensils] = useState(false)

  // Delivery settings (Stage 6)
  const [deliveryMethod, setDeliveryMethod] = useState<'OWN_DELIVERY' | 'THIRD_PARTY'>('THIRD_PARTY')
  const [ownPrimaryRadius, setOwnPrimaryRadius] = useState('')
  const [ownPrimaryFeeType, setOwnPrimaryFeeType] = useState<'FIXED' | 'PERCENT'>('FIXED')
  const [ownPrimaryFeeValue, setOwnPrimaryFeeValue] = useState('')
  const [ownSecondaryRadius, setOwnSecondaryRadius] = useState('')
  const [ownSecondaryFeeType, setOwnSecondaryFeeType] = useState<'FIXED' | 'PERCENT'>('FIXED')
  const [ownSecondaryFeeValue, setOwnSecondaryFeeValue] = useState('')
  const [thirdPartySubsidyPct, setThirdPartySubsidyPct] = useState('0')

  // Skipped / blackout days (Stage 7)
  const [skippedDays, setSkippedDays] = useState<{ name: string; fromDate: string; toDate: string }[]>([])

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
        setOffersPickup(d.offers_pickup !== false); setOffersDelivery(d.offers_delivery !== false)
        setServiceChargePct(String(d.service_charge_pct ?? 0)); setServiceChargeName(d.service_charge_name || '')
        setTipDefaultType(d.tip_default_type === 'CUSTOM' ? 'CUSTOM' : d.tip_default_type === 'NONE' ? 'NONE' : 'PERCENTAGE')
        setTipDefaultValue(String(d.tip_default_value ?? 15))
        setPickupOrderMinimum(String(d.pickup_order_minimum ?? 0)); setDeliveryOrderMinimum(String(d.delivery_order_minimum ?? 0))
        setMaxOrdersPerDay(d.max_orders_per_day != null ? String(d.max_orders_per_day) : '')
        setLeadTimeHours(String(d.lead_time_hours ?? 24)); setRollingAvailabilityDays(String(d.rolling_availability_days ?? 90))
        setDailyCutoffTime(d.daily_cutoff_time || ''); setHardCutoffDate(d.hard_cutoff_date || '')
        setIncludeUtensils(d.include_utensils === true)
        const del = d.delivery_settings || {}
        setDeliveryMethod(del.method === 'OWN_DELIVERY' ? 'OWN_DELIVERY' : 'THIRD_PARTY')
        setThirdPartySubsidyPct(String(del.thirdPartySubsidyPct ?? 0))
        const p = del.own?.primary, sec = del.own?.secondary
        if (p) { setOwnPrimaryRadius(String(p.radiusMiles ?? '')); setOwnPrimaryFeeType(p.feeType === 'PERCENT' ? 'PERCENT' : 'FIXED'); setOwnPrimaryFeeValue(String(p.feeValue ?? '')) }
        if (sec) { setOwnSecondaryRadius(String(sec.radiusMiles ?? '')); setOwnSecondaryFeeType(sec.feeType === 'PERCENT' ? 'PERCENT' : 'FIXED'); setOwnSecondaryFeeValue(String(sec.feeValue ?? '')) }
        if (Array.isArray(d.skipped_days)) setSkippedDays(d.skipped_days.map((s: { name?: string; fromDate?: string; toDate?: string }) => ({ name: s.name || '', fromDate: s.fromDate || '', toDate: s.toDate || s.fromDate || '' })))
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
      name: name.trim(), type: MENU_TYPE_DEFAULT, url: effectiveSlug, urlAuto: !urlDirty,
      imageUrl: imageUrl || undefined, visible,
      availabilityMode, startDate: startDate || undefined, endDate: endDate || undefined,
      scheduleConfig,
      offersPickup, offersDelivery,
      serviceChargePct: parseFloat(serviceChargePct) || 0, serviceChargeName: serviceChargeName || undefined,
      tipDefaultType, tipDefaultValue: parseFloat(tipDefaultValue) || 0,
      pickupOrderMinimum: parseFloat(pickupOrderMinimum) || 0, deliveryOrderMinimum: parseFloat(deliveryOrderMinimum) || 0,
      maxOrdersPerDay: maxOrdersPerDay.trim() === '' ? null : (parseInt(maxOrdersPerDay, 10) || 0),
      leadTimeHours: parseInt(leadTimeHours, 10) || 0, rollingAvailabilityDays: parseInt(rollingAvailabilityDays, 10) || 90,
      dailyCutoffTime: dailyCutoffTime || undefined, hardCutoffDate: hardCutoffDate || undefined,
      includeUtensils,
      deliverySettings: {
        method: deliveryMethod,
        thirdPartySubsidyPct: Math.max(0, Math.min(15, parseFloat(thirdPartySubsidyPct) || 0)),
        own: deliveryMethod === 'OWN_DELIVERY' ? {
          ...(ownPrimaryRadius.trim() ? { primary: { radiusMiles: parseFloat(ownPrimaryRadius) || 0, feeType: ownPrimaryFeeType, feeValue: parseFloat(ownPrimaryFeeValue) || 0 } } : {}),
          ...(ownSecondaryRadius.trim() ? { secondary: { radiusMiles: parseFloat(ownSecondaryRadius) || 0, feeType: ownSecondaryFeeType, feeValue: parseFloat(ownSecondaryFeeValue) || 0 } } : {}),
        } : undefined,
      },
      skippedDays: skippedDays.filter(s => s.fromDate).map(s => ({ name: s.name || undefined, fromDate: s.fromDate, toDate: s.toDate || s.fromDate })),
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

        {/* Order settings (Stage 5) */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 14 }}>Order Settings</div>

          <label style={label}>Fulfillment types offered</label>
          <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
            <label style={radioRow(offersPickup)}><input type="checkbox" checked={offersPickup} onChange={e => setOffersPickup(e.target.checked)} style={{ accentColor: BLUE }} /> Pickup</label>
            <label style={radioRow(offersDelivery)}><input type="checkbox" checked={offersDelivery} onChange={e => setOffersDelivery(e.target.checked)} style={{ accentColor: BLUE }} /> Delivery</label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div><label style={label}>Service charge (%)</label><input value={serviceChargePct} onChange={e => setServiceChargePct(e.target.value)} inputMode="decimal" style={inputStyle} /></div>
            <div><label style={label}>Service charge name</label><input value={serviceChargeName} onChange={e => setServiceChargeName(e.target.value)} placeholder="e.g. Service fee" style={inputStyle} /></div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={label}>Default tip</label>
              <select value={tipDefaultType} onChange={e => setTipDefaultType(e.target.value as 'PERCENTAGE' | 'CUSTOM' | 'NONE')} style={inputStyle}>
                <option value="PERCENTAGE">Percentage</option><option value="CUSTOM">Fixed $</option><option value="NONE">No default</option>
              </select>
            </div>
            <div><label style={label}>{tipDefaultType === 'CUSTOM' ? 'Default tip ($)' : 'Default tip (%)'}</label><input value={tipDefaultValue} onChange={e => setTipDefaultValue(e.target.value)} inputMode="decimal" disabled={tipDefaultType === 'NONE'} style={{ ...inputStyle, opacity: tipDefaultType === 'NONE' ? 0.5 : 1 }} /></div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div><label style={label}>Pickup minimum ($)</label><input value={pickupOrderMinimum} onChange={e => setPickupOrderMinimum(e.target.value)} inputMode="decimal" style={inputStyle} /></div>
            <div><label style={label}>Delivery minimum ($)</label><input value={deliveryOrderMinimum} onChange={e => setDeliveryOrderMinimum(e.target.value)} inputMode="decimal" style={inputStyle} /></div>
            <div><label style={label}>Max orders/day</label><input value={maxOrdersPerDay} onChange={e => setMaxOrdersPerDay(e.target.value)} inputMode="numeric" placeholder="No limit" style={inputStyle} /></div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div><label style={label}>Lead time (hours)</label><input value={leadTimeHours} onChange={e => setLeadTimeHours(e.target.value)} inputMode="numeric" style={inputStyle} /></div>
            <div>
              <label style={label}>Bookable window</label>
              <select value={rollingAvailabilityDays} onChange={e => setRollingAvailabilityDays(e.target.value)} style={inputStyle}>
                <option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={label}>Daily cutoff time</label><input type="time" value={dailyCutoffTime} onChange={e => setDailyCutoffTime(e.target.value)} style={inputStyle} /><div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Same-day orders stop at this time.</div></div>
            <div><label style={label}>Hard cutoff date</label><input type="date" value={hardCutoffDate} onChange={e => setHardCutoffDate(e.target.value)} style={inputStyle} /><div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Ordering closes after this date.</div></div>
          </div>
        </div>

        {/* Utensils (small extra) */}
        <div style={card}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: DARK }}>
            <input type="checkbox" checked={includeUtensils} onChange={e => setIncludeUtensils(e.target.checked)} style={{ width: 16, height: 16, accentColor: BLUE, cursor: 'pointer' }} />
            Offer an “Include utensils” option at checkout
          </label>
        </div>

        {/* Delivery settings (Stage 6) */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 14 }}>Delivery</div>
          <label style={label}>Delivery method</label>
          <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
            <label style={radioRow(deliveryMethod === 'THIRD_PARTY')}><input type="radio" checked={deliveryMethod === 'THIRD_PARTY'} onChange={() => setDeliveryMethod('THIRD_PARTY')} style={{ accentColor: BLUE }} /> Third-party (Disco arranges a courier)</label>
            <label style={radioRow(deliveryMethod === 'OWN_DELIVERY')}><input type="radio" checked={deliveryMethod === 'OWN_DELIVERY'} onChange={() => setDeliveryMethod('OWN_DELIVERY')} style={{ accentColor: BLUE }} /> Self-delivery</label>
          </div>

          {deliveryMethod === 'OWN_DELIVERY' ? (
            <>
              <label style={label}>Primary zone</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div><input value={ownPrimaryRadius} onChange={e => setOwnPrimaryRadius(e.target.value)} inputMode="decimal" placeholder="Radius (mi)" style={inputStyle} /></div>
                <select value={ownPrimaryFeeType} onChange={e => setOwnPrimaryFeeType(e.target.value as 'FIXED' | 'PERCENT')} style={inputStyle}><option value="FIXED">$ fixed</option><option value="PERCENT">% of order</option></select>
                <div><input value={ownPrimaryFeeValue} onChange={e => setOwnPrimaryFeeValue(e.target.value)} inputMode="decimal" placeholder={ownPrimaryFeeType === 'PERCENT' ? 'Fee %' : 'Fee $'} style={inputStyle} /></div>
              </div>
              <label style={label}>Secondary zone (optional)</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div><input value={ownSecondaryRadius} onChange={e => setOwnSecondaryRadius(e.target.value)} inputMode="decimal" placeholder="Radius (mi)" style={inputStyle} /></div>
                <select value={ownSecondaryFeeType} onChange={e => setOwnSecondaryFeeType(e.target.value as 'FIXED' | 'PERCENT')} style={inputStyle}><option value="FIXED">$ fixed</option><option value="PERCENT">% of order</option></select>
                <div><input value={ownSecondaryFeeValue} onChange={e => setOwnSecondaryFeeValue(e.target.value)} inputMode="decimal" placeholder={ownSecondaryFeeType === 'PERCENT' ? 'Fee %' : 'Fee $'} style={inputStyle} /></div>
              </div>
            </>
          ) : (
            <div>
              <div style={{ fontSize: 12.5, color: '#888', background: '#f7f7fb', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
                Disco arranges the courier. The delivery fee is a flat <strong>15% of subtotal, capped at $85</strong> (set platform-wide). By default the customer pays it in full.
              </div>
              <label style={label}>Delivery subsidy (0–15%)</label>
              <input value={thirdPartySubsidyPct} onChange={e => setThirdPartySubsidyPct(e.target.value)} inputMode="decimal" style={{ ...inputStyle, maxWidth: 160 }} />
              <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>
                How much of the 15% fee your restaurant covers, lowering the customer’s delivery cost. At 15% the customer pays $0 and you cover the whole fee. Comes out of your payout.
              </div>
            </div>
          )}
        </div>

        {/* Blackout dates (Stage 7) */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 4 }}>Blackout Dates</div>
          <div style={{ fontSize: 12, color: '#999', marginBottom: 14 }}>Dates this menu is unavailable (holidays, closures). For restaurant-wide closures, use Closed Days.</div>
          {skippedDays.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 1.4fr auto', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input value={s.name} onChange={e => setSkippedDays(a => a.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Name (e.g. Thanksgiving)" style={inputStyle} />
              <input type="date" value={s.fromDate} onChange={e => setSkippedDays(a => a.map((x, j) => j === i ? { ...x, fromDate: e.target.value, toDate: x.toDate || e.target.value } : x))} style={inputStyle} />
              <input type="date" value={s.toDate} onChange={e => setSkippedDays(a => a.map((x, j) => j === i ? { ...x, toDate: e.target.value } : x))} style={inputStyle} />
              <button type="button" onClick={() => setSkippedDays(a => a.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: RED, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
          ))}
          <button type="button" onClick={() => setSkippedDays(a => [...a, { name: '', fromDate: '', toDate: '' }])} style={{ background: 'none', border: '1px dashed #ccc', borderRadius: 8, padding: '8px 14px', fontSize: 13, color: BLUE, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>+ Add blackout date</button>
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
