'use client'
import { useEffect, useMemo, useState } from 'react'
import { TimeSelect, normalizeTime } from '../../_components/TimeSelect'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'

// Mirrors FM's IRepeatWeekDays / ISkippedDay / IScheduleOption shapes.
interface RepeatWeekDay { days: string; fromPickUpTime: string; toPickUpTime: string }
interface SkippedDay { name: string; fromDate: string; toDate: string; intervals: { fromTime: string; toTime: string }[] }
interface ScheduleOption {
  rollingAvailability: number
  repeatWeekDays: RepeatWeekDay[]
  scheduleType: 'SAME_DAY' | 'CUSTOM'
  maxOrder: number | null
  prepTime: number
  cutOff?: string
  cutOffDate?: string
  cutOffType?: 'DAILY' | 'BY_DATE'
  startDate?: string
  endDate?: string
  skippedDays?: SkippedDay[]
}
interface MenuSettings {
  pickupOrderMinimum?: number
  deliveryOrderMinimum?: number
  menuAvailability?: string[]
  deliveryType?: 'OWN_DELIVERY' | 'NASH_DELIVERY'
  ownDeliveryRadius?: number | null
  ownDeliveryFee?: number | null
  ownDeliveryFeePercent?: number | null
  secondaryOwnDeliveryRadius?: number | null
  secondaryOwnDeliveryFee?: number | null
  secondaryOwnDeliveryFeePercent?: number | null
  thirdPartyDeliverySubsidingPercent?: number | null
  serviceCharge?: number | null
  serviceChargeName?: string | null
  tipOption?: { tipsPrice: number; tipsType: 'PERCENTAGE' | 'CUSTOM' }
}
interface FullMenu {
  reference: string
  name: string
  menuType?: string
  type?: string
  url?: string
  visible?: boolean
  archived?: boolean
  scheduleOption?: ScheduleOption
  settings?: MenuSettings
}

const DAY_KEYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
type DayKey = typeof DAY_KEYS[number]

// normalizeTime + the 15-minute TimeSelect now live in ../../_components/TimeSelect
// (shared with the Disco-native menu form). Imported at the top of this file.
const DAY_LABELS: Record<DayKey, string> = {
  MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed', THURSDAY: 'Thu',
  FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun',
}

// FM FAKE_MENU_CATEGORIES (fake-data.constant.ts:675-717). The per-menu
// `type` field uses these values.
// Menu Category is intentionally dropped as a Disco concept. FM's MenuRequestDto
// still requires a `type`, so we always send this fixed hidden constant — never
// surfaced in the UI.
const FM_MENU_TYPE_DEFAULT = 'GENERAL_CATERING'

interface Props {
  // Omit for create mode (opens the same rich dialog; first save POST-creates).
  menuRef?: string | null
  onClose: () => void
  onSaved: () => void
}

function emptyScheduleOption(): ScheduleOption {
  return {
    rollingAvailability: 30,
    repeatWeekDays: [],
    scheduleType: 'SAME_DAY',
    maxOrder: null,
    prepTime: 24,
  }
}
function emptySettings(): MenuSettings {
  return {
    pickupOrderMinimum: 0,
    deliveryOrderMinimum: 0,
    menuAvailability: ['PICKUP', 'DELIVERY'],
    deliveryType: 'OWN_DELIVERY',
  }
}

export default function MenuSettingsDialog({ menuRef, onClose, onSaved }: Props) {
  const isNew = !menuRef
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [menu, setMenu] = useState<FullMenu | null>(null)

  // form state
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const [includeUtensils, setIncludeUtensils] = useState(false)   // Disco-only per-menu toggle (disco_menu_settings)
  const [visible, setVisible] = useState(true)
  const [archived, setArchived] = useState(false)

  // tips & surcharges (FM tipOption + serviceCharge)
  const [tipMode, setTipMode] = useState<10 | 15 | 20 | 'CUSTOM'>(10)
  const [customTip, setCustomTip] = useState('')           // dollars, CUSTOM only
  const [serviceCharge, setServiceCharge] = useState('')    // percentage points
  const [serviceChargeName, setServiceChargeName] = useState('')

  // delivery fulfillment (FM settings.deliveryType + own-delivery tiers)
  const [deliveryType, setDeliveryType] = useState<'OWN_DELIVERY' | 'NASH_DELIVERY'>('OWN_DELIVERY')
  const [ownRadius, setOwnRadius] = useState('')            // miles
  const [ownFeeMode, setOwnFeeMode] = useState<'currency' | 'percentage'>('currency')
  const [ownFee, setOwnFee] = useState('')                 // dollars (2dp)
  const [ownFeePercent, setOwnFeePercent] = useState('')    // percent (3dp)
  const [secRadius, setSecRadius] = useState('')
  const [secFeeMode, setSecFeeMode] = useState<'currency' | 'percentage'>('currency')
  const [secFee, setSecFee] = useState('')
  const [secFeePercent, setSecFeePercent] = useState('')
  const [thirdPartySubsidy, setThirdPartySubsidy] = useState('')  // percent (FM default 20)

  // scheduling override (FM scheduleOption.skippedDays)
  const [skippedDays, setSkippedDays] = useState<SkippedDay[]>([])

  // service type
  const [pickup, setPickup] = useState(true)
  const [delivery, setDelivery] = useState(true)

  // schedule
  const [scheduleType, setScheduleType] = useState<'SAME_DAY' | 'CUSTOM'>('SAME_DAY')
  const [enabledDays, setEnabledDays] = useState<Record<DayKey, boolean>>({
    MONDAY: false, TUESDAY: false, WEDNESDAY: false, THURSDAY: false,
    FRIDAY: false, SATURDAY: false, SUNDAY: false,
  })
  // SAME_DAY: one shared window. CUSTOM: per-day windows.
  const [sameDayFrom, setSameDayFrom] = useState('11:00')
  const [sameDayTo, setSameDayTo] = useState('19:00')
  const [perDay, setPerDay] = useState<Record<DayKey, { from: string; to: string }>>({
    MONDAY: { from: '11:00', to: '19:00' }, TUESDAY: { from: '11:00', to: '19:00' },
    WEDNESDAY: { from: '11:00', to: '19:00' }, THURSDAY: { from: '11:00', to: '19:00' },
    FRIDAY: { from: '11:00', to: '19:00' }, SATURDAY: { from: '11:00', to: '19:00' },
    SUNDAY: { from: '11:00', to: '19:00' },
  })

  // timing
  const [rollingAvailability, setRollingAvailability] = useState(30)
  // Lead Time (FM scheduleOption.prepTime = prepDays*24 + prepHours)
  const [prepDays, setPrepDays] = useState(1)
  const [prepHours, setPrepHours] = useState(0)
  // Daily Cutoff (FM scheduleOption.cutOff). Hard Cutoff (FM
  // scheduleOption.cutOffDate; we store "YYYY-MM-DDTHH:mm" to carry the time FM
  // itself omits). The two are independent in Disco even though FM's single
  // cutOffType can't hold both — see lib/scheduling/cutoffs.ts.
  const [dailyCutoffEnabled, setDailyCutoffEnabled] = useState(false)
  const [dailyCutoff, setDailyCutoff] = useState('09:00')
  const [hardCutoffEnabled, setHardCutoffEnabled] = useState(false)
  const [hardCutoffDate, setHardCutoffDate] = useState('')
  const [hardCutoffTime, setHardCutoffTime] = useState('17:00')

  // minimums
  const [pickupMin, setPickupMin] = useState(0)
  const [deliveryMin, setDeliveryMin] = useState(0)
  const [maxOrder, setMaxOrder] = useState<number | ''>('')

  // ── load menu ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancel = false
    // Create mode — no menu to load; start with the empty defaults already set.
    if (!menuRef) { setLoading(false); return () => { cancel = true } }
    // Disco-only per-menu settings (side-store keyed by the FM menu ref): image +
    // the "Include Utensils" toggle.
    fetch(`/api/restaurant/menu-settings?menuRef=${menuRef}`)
      .then(r => (r.ok ? r.json() : null)).then(d => { if (cancel || !d) return; if (d.imageUrl) setImageUrl(String(d.imageUrl)); setIncludeUtensils(d.includeUtensils === true) }).catch(() => {})
    setLoading(true); setErr(null)
    fetch(`/api/restaurant/menus/${menuRef}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Load failed (${r.status})`)))
      .then((m: FullMenu) => {
        if (cancel) return
        setMenu(m)
        setName(m.name || '')
        setUrl(m.url || '')
        setVisible(m.visible !== false)
        setArchived(!!m.archived)

        const sched = m.scheduleOption || emptyScheduleOption()
        const settings = m.settings || emptySettings()

        const avail = settings.menuAvailability || []
        setPickup(avail.includes('PICKUP'))
        setDelivery(avail.includes('DELIVERY'))

        // Tips & surcharges
        const tip = settings.tipOption
        if (tip) {
          if (tip.tipsType === 'CUSTOM') {
            setTipMode('CUSTOM')
            setCustomTip(tip.tipsPrice != null ? String(tip.tipsPrice) : '')
          } else if (tip.tipsPrice === 15) setTipMode(15)
          else if (tip.tipsPrice === 20) setTipMode(20)
          else setTipMode(10)
        }
        setServiceCharge(settings.serviceCharge != null ? String(settings.serviceCharge) : '')
        setServiceChargeName(settings.serviceChargeName || '')

        // Delivery fulfillment. FM picks the fee mode from which field has a
        // value (menu-settings-v2.component.ts:338-355): a $ amount → currency,
        // a percent → percentage, default currency.
        setDeliveryType(settings.deliveryType === 'NASH_DELIVERY' ? 'NASH_DELIVERY' : 'OWN_DELIVERY')
        setOwnRadius(settings.ownDeliveryRadius != null ? String(settings.ownDeliveryRadius) : '')
        if (settings.ownDeliveryFeePercent != null && settings.ownDeliveryFee == null) {
          setOwnFeeMode('percentage'); setOwnFeePercent(String(settings.ownDeliveryFeePercent)); setOwnFee('')
        } else {
          setOwnFeeMode('currency'); setOwnFee(settings.ownDeliveryFee != null ? String(settings.ownDeliveryFee) : ''); setOwnFeePercent('')
        }
        setSecRadius(settings.secondaryOwnDeliveryRadius != null ? String(settings.secondaryOwnDeliveryRadius) : '')
        if (settings.secondaryOwnDeliveryFeePercent != null && settings.secondaryOwnDeliveryFee == null) {
          setSecFeeMode('percentage'); setSecFeePercent(String(settings.secondaryOwnDeliveryFeePercent)); setSecFee('')
        } else {
          setSecFeeMode('currency'); setSecFee(settings.secondaryOwnDeliveryFee != null ? String(settings.secondaryOwnDeliveryFee) : ''); setSecFeePercent('')
        }
        setThirdPartySubsidy(settings.thirdPartyDeliverySubsidingPercent != null ? String(settings.thirdPartyDeliverySubsidingPercent) : '')

        setSkippedDays(sched.skippedDays || [])

        setScheduleType(sched.scheduleType || 'SAME_DAY')
        setRollingAvailability(sched.rollingAvailability ?? 30)
        const totalHours = Math.max(0, Math.floor(sched.prepTime ?? 24))
        setPrepDays(Math.floor(totalHours / 24))
        setPrepHours(totalHours % 24)
        // Daily cutoff: present whenever scheduleOption.cutOff is set.
        setDailyCutoffEnabled(!!sched.cutOff)
        setDailyCutoff(normalizeTime(sched.cutOff) || '09:00')
        // Hard cutoff: scheduleOption.cutOffDate, which may be date-only
        // (legacy/FM) or "YYYY-MM-DDTHH:mm" (Disco).
        if (sched.cutOffDate) {
          setHardCutoffEnabled(true)
          const [d, t] = sched.cutOffDate.split('T')
          setHardCutoffDate(d || '')
          setHardCutoffTime(normalizeTime(t) || '17:00')
        } else {
          setHardCutoffEnabled(false)
        }

        // Hydrate days + windows from repeatWeekDays.
        const dayMap: Record<DayKey, boolean> = {
          MONDAY: false, TUESDAY: false, WEDNESDAY: false, THURSDAY: false,
          FRIDAY: false, SATURDAY: false, SUNDAY: false,
        }
        const perMap: Record<DayKey, { from: string; to: string }> = { ...perDay }
        let firstFrom = ''
        let firstTo = ''
        for (const w of (sched.repeatWeekDays || [])) {
          const days = (w.days || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean) as DayKey[]
          for (const d of days) {
            if (d in dayMap) {
              dayMap[d] = true
              perMap[d] = { from: normalizeTime(w.fromPickUpTime) || '11:00', to: normalizeTime(w.toPickUpTime) || '19:00' }
              if (!firstFrom) { firstFrom = normalizeTime(w.fromPickUpTime); firstTo = normalizeTime(w.toPickUpTime) }
            }
          }
        }
        setEnabledDays(dayMap)
        setPerDay(perMap)
        if (firstFrom) setSameDayFrom(firstFrom)
        if (firstTo) setSameDayTo(firstTo)

        setPickupMin(settings.pickupOrderMinimum ?? 0)
        setDeliveryMin(settings.deliveryOrderMinimum ?? 0)
        setMaxOrder(sched.maxOrder ?? '')
      })
      .catch(e => { if (!cancel) setErr(e.message || 'Failed to load menu') })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuRef])

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // ESC closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const activeDays = useMemo(() => DAY_KEYS.filter(d => enabledDays[d]), [enabledDays])

  function toggleDay(d: DayKey) { setEnabledDays(s => ({ ...s, [d]: !s[d] })) }

  function buildRepeatWeekDays(): RepeatWeekDay[] {
    if (activeDays.length === 0) return []
    // FM's Days enum takes ONE day per repeatWeekDays entry, so emit one entry per
    // selected day — never a comma-joined string (FM 500s: "Cannot deserialize value
    // of type `Days` from String \"MONDAY,TUESDAY,...\""). SAME_DAY shares one window
    // across every selected day; CUSTOM uses each day's own window. Both now produce
    // the same shape FM accepts (CUSTOM already did — that path was never broken).
    if (scheduleType === 'SAME_DAY') {
      return activeDays.map(d => ({ days: d, fromPickUpTime: sameDayFrom, toPickUpTime: sameDayTo }))
    }
    return activeDays.map(d => ({ days: d, fromPickUpTime: perDay[d].from, toPickUpTime: perDay[d].to }))
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { setErr('Image is too large (max 5MB).'); return }
    setUploadingImage(true); setErr(null)
    try {
      const fd = new FormData(); fd.append('image', file)
      const res = await fetch('/api/become-a-partner/logo', { method: 'POST', body: fd })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d?.url) setImageUrl(String(d.url)); else setErr(d?.error || 'Could not upload image.')
    } finally { setUploadingImage(false) }
  }

  async function save() {
    setErr(null)
    if (!name.trim()) { setErr('Menu name is required'); return }
    if (!pickup && !delivery) { setErr('Select at least one service type'); return }

    setSaving(true)
    try {
      const repeatWeekDays = buildRepeatWeekDays()
      const totalPrepHours = Math.max(0, prepDays) * 24 + Math.max(0, prepHours)
      const menuAvailability: string[] = []
      if (pickup) menuAvailability.push('PICKUP')
      if (delivery) menuAvailability.push('DELIVERY')

      const scheduleOption: ScheduleOption = {
        ...(menu?.scheduleOption || emptyScheduleOption()),
        scheduleType,
        rollingAvailability,
        repeatWeekDays,
        prepTime: totalPrepHours,
        maxOrder: maxOrder === '' ? null : Number(maxOrder),
        // Daily + Hard cutoffs are independent. cutOffType reflects precedence
        // for FM's single-field consumers (Disco reads both fields directly).
        cutOff: dailyCutoffEnabled ? dailyCutoff : undefined,
        cutOffDate: hardCutoffEnabled && hardCutoffDate ? `${hardCutoffDate}T${hardCutoffTime}` : undefined,
        cutOffType: hardCutoffEnabled && hardCutoffDate ? 'BY_DATE' : (dailyCutoffEnabled ? 'DAILY' : undefined),
        // FM only attaches skippedDays when there are any (component.ts:1022).
        skippedDays: skippedDays.length ? skippedDays : undefined,
      }

      // FM stores ONE of fee / feePercent per tier and nulls the other based
      // on the $/% toggle (menu-settings-v2.component.ts:497-531, 999-1005).
      const settings: MenuSettings = {
        ...(menu?.settings || emptySettings()),
        pickupOrderMinimum: Number(pickupMin) || 0,
        deliveryOrderMinimum: Number(deliveryMin) || 0,
        menuAvailability,
        deliveryType,
        ownDeliveryRadius: numOrNull(ownRadius),
        ownDeliveryFee: ownFeeMode === 'currency' ? numOrNull(ownFee) : null,
        ownDeliveryFeePercent: ownFeeMode === 'percentage' ? numOrNull(ownFeePercent) : null,
        secondaryOwnDeliveryRadius: numOrNull(secRadius),
        secondaryOwnDeliveryFee: secFeeMode === 'currency' ? numOrNull(secFee) : null,
        secondaryOwnDeliveryFeePercent: secFeeMode === 'percentage' ? numOrNull(secFeePercent) : null,
        thirdPartyDeliverySubsidingPercent: numOrNull(thirdPartySubsidy),
        serviceCharge: numOrNull(serviceCharge),
        serviceChargeName: serviceChargeName.trim() || null,
        tipOption: {
          tipsPrice: tipMode === 'CUSTOM' ? (Number(customTip) || 0) : tipMode,
          tipsType: tipMode === 'CUSTOM' ? 'CUSTOM' : 'PERCENTAGE',
        },
      }

      const body = {
        ...(menu || {}),
        name: name.trim(),
        type: FM_MENU_TYPE_DEFAULT, // Menu Category dropped from Disco; FM requires a type.
        url,
        scheduleOption,
        settings,
      }

      let ref = menuRef || ''
      if (isNew) {
        // Create mode → POST-create the FM menu, then apply non-default
        // visible/archived via the dedicated endpoints on the new ref.
        const postRes = await fetch('/api/restaurant/menus', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!postRes.ok) { const ed = await postRes.json().catch(() => ({})); throw new Error(ed.raw || ed.error || `Create failed (${postRes.status})`) }
        const created = await postRes.json().catch(() => ({}))
        ref = created.reference || created.id || (created.data && created.data.reference) || ''
        if (ref && !visible) await fetch(`/api/restaurant/menus/${ref}/visible?isVisible=false`, { method: 'PUT' }).catch(() => {})
        if (ref && archived) await fetch(`/api/restaurant/menus/${ref}/archive?isArchived=true`, { method: 'PUT' }).catch(() => {})
      } else {
        const putRes = await fetch(`/api/restaurant/menus/${menuRef}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!putRes.ok) { const ed = await putRes.json().catch(() => ({})); throw new Error(ed.raw || ed.error || `Save failed (${putRes.status})`) }
        // Separate endpoints for visible/archive toggles (edit only).
        if (visible !== (menu?.visible !== false)) {
          await fetch(`/api/restaurant/menus/${menuRef}/visible?isVisible=${visible}`, { method: 'PUT' })
        }
        if (archived !== !!menu?.archived) {
          await fetch(`/api/restaurant/menus/${menuRef}/archive?isArchived=${archived}`, { method: 'PUT' })
        }
      }

      // Persist the Disco-only menu settings (image + Include Utensils toggle),
      // side-store keyed by the FM menu ref.
      if (ref) {
        await fetch('/api/restaurant/menu-settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ menuRef: ref, imageUrl, includeUtensils }),
        }).catch(() => {})
      }

      onSaved()
    } catch (e) {
      setErr((e as Error).message || 'Unable to save')
    } finally {
      setSaving(false)
    }
  }

  // ── styles ───────────────────────────────────────────────────────────
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0',
    borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff',
  }
  const sectionStyle: React.CSSProperties = {
    border: '1px solid #eee', borderRadius: 12, padding: '20px 22px',
    background: '#fff', marginBottom: 16,
  }
  const sectionTitle: React.CSSProperties = {
    fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 14,
    textTransform: 'uppercase', letterSpacing: '0.04em',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.45)', zIndex: 1100,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', fontFamily: F,
    }}>
      <div style={{
        width: '100%', maxWidth: 720, background: '#f7f7fb', height: '100vh',
        display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 28px rgba(0,0,0,0.16)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 22px', borderBottom: '1px solid #ececf2', background: '#fff', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 11, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{isNew ? 'Create Menu' : 'Menu Settings'}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginTop: 2 }}>{name || '…'}</div>
          </div>
          <button onClick={onClose} aria-label="Close" disabled={saving}
            style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 34, height: 34, borderRadius: '50%', fontSize: 18, color: '#555' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          {loading ? (
            <div style={{ color: '#aaa', fontSize: 13, textAlign: 'center', padding: '60px 0' }}>Loading…</div>
          ) : (
            <>
              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#DC2626', fontWeight: 500 }}>
                  {err}
                </div>
              )}

              {/* General */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>General</div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Menu name</label>
                  <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>URL slug</label>
                  <input style={inputStyle} value={url} onChange={e => setUrl(e.target.value)} placeholder="catering" />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Menu image</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    {imageUrl
                      ? <img src={imageUrl} alt="" style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover', border: '1px solid #eee' }} />
                      : <div style={{ width: 64, height: 64, borderRadius: 8, background: '#f4f4f8', border: '1px solid #eee' }} />}
                    <label style={{ fontSize: 13, color: INDIGO, fontWeight: 600, cursor: 'pointer' }}>
                      {uploadingImage ? 'Uploading…' : (imageUrl ? 'Replace image' : 'Upload image')}
                      <input type="file" accept="image/jpeg,image/png" onChange={handleImageUpload} style={{ display: 'none' }} />
                    </label>
                  </div>
                  <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>.jpg or .png, up to 5MB.</div>
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Toggle label="Visible (active)" checked={visible} onChange={setVisible} />
                  <Toggle label="Archived" checked={archived} onChange={setArchived} />
                  <Toggle label="Include utensils" checked={includeUtensils} onChange={setIncludeUtensils} />
                </div>
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>
                  Include utensils: offers customers an optional “Include utensils” checkbox at checkout for this menu.
                </div>
              </div>

              {/* Service type */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Service type</div>
                <div style={{ fontSize: 12, color: '#777', marginBottom: 12 }}>
                  Which fulfillment options can customers choose for this menu?
                </div>
                <div style={{ display: 'flex', gap: 14 }}>
                  <Check label="Pickup" checked={pickup} onChange={setPickup} />
                  <Check label="Delivery" checked={delivery} onChange={setDelivery} />
                </div>
              </div>

              {/* Schedule */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Schedule</div>
                <div style={{ fontSize: 12, color: '#777', marginBottom: 12, lineHeight: 1.5 }}>
                  Pick the days this menu is available and the pickup/delivery time window for each.
                  These windows determine which time slots customers see when they order.
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Time-window mode</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <ModeBtn active={scheduleType === 'SAME_DAY'} onClick={() => setScheduleType('SAME_DAY')}>Same window all days</ModeBtn>
                    <ModeBtn active={scheduleType === 'CUSTOM'} onClick={() => setScheduleType('CUSTOM')}>Per-day windows</ModeBtn>
                  </div>
                </div>

                {/* Day picker */}
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Days of week</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {DAY_KEYS.map(d => (
                      <button key={d} type="button" onClick={() => toggleDay(d)}
                        style={{
                          padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                          border: '1.5px solid ' + (enabledDays[d] ? INDIGO : '#e0e0e0'),
                          background: enabledDays[d] ? INDIGO : '#fff',
                          color: enabledDays[d] ? '#fff' : '#555', cursor: 'pointer', fontFamily: F,
                        }}>{DAY_LABELS[d]}</button>
                    ))}
                  </div>
                </div>

                {/* Time windows */}
                {scheduleType === 'SAME_DAY' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <div>
                      <label style={labelStyle}>From</label>
                      <TimeSelect style={inputStyle} value={sameDayFrom} onChange={setSameDayFrom} />
                    </div>
                    <div>
                      <label style={labelStyle}>To</label>
                      <TimeSelect style={inputStyle} value={sameDayTo} onChange={setSameDayTo} />
                    </div>
                  </div>
                ) : (
                  <div>
                    {activeDays.length === 0 && (
                      <div style={{ fontSize: 12, color: '#aaa', padding: '12px 0' }}>Select at least one day above.</div>
                    )}
                    {activeDays.map(d => (
                      <div key={d} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>{DAY_LABELS[d]}</div>
                        <TimeSelect style={inputStyle} value={perDay[d].from}
                          onChange={v => setPerDay(s => ({ ...s, [d]: { ...s[d], from: v } }))} />
                        <TimeSelect style={inputStyle} value={perDay[d].to}
                          onChange={v => setPerDay(s => ({ ...s, [d]: { ...s[d], to: v } }))} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Lead Time & Cutoffs */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Lead Time &amp; Cutoffs</div>

                {/* Lead Time */}
                <div style={{ fontSize: 12, fontWeight: 700, color: '#666', marginBottom: 8 }}>Lead Time</div>
                <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }}>Minimum notice required before pickup/delivery.</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 18 }}>
                  <div>
                    <label style={labelStyle}>Days</label>
                    <input type="number" min={0} style={inputStyle} value={prepDays}
                      onChange={e => setPrepDays(Math.max(0, parseInt(e.target.value || '0', 10)))} />
                  </div>
                  <div>
                    <label style={labelStyle}>Hours</label>
                    <input type="number" min={0} max={23} style={inputStyle} value={prepHours}
                      onChange={e => setPrepHours(Math.max(0, Math.min(23, parseInt(e.target.value || '0', 10))))} />
                  </div>
                  <div>
                    <label style={labelStyle}>Bookable window (days)</label>
                    <select style={inputStyle} value={rollingAvailability} onChange={e => setRollingAvailability(parseInt(e.target.value, 10))}>
                      <option value={30}>30 days</option>
                      <option value={60}>60 days</option>
                      <option value={90}>90 days</option>
                    </select>
                  </div>
                </div>

                {/* Daily Cutoff */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#666' }}>Daily Cutoff</div>
                  <Toggle label="" checked={dailyCutoffEnabled} onChange={setDailyCutoffEnabled} />
                </div>
                <div style={{ fontSize: 12, color: '#777', marginBottom: dailyCutoffEnabled ? 10 : 18 }}>Ordering for the same day stops at this time.</div>
                {dailyCutoffEnabled && (
                  <div style={{ maxWidth: 220, marginBottom: 18 }}>
                    <label style={labelStyle}>Cutoff time</label>
                    <TimeSelect style={inputStyle} value={dailyCutoff} onChange={setDailyCutoff} />
                  </div>
                )}

                {/* Hard Cutoff */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#666' }}>Hard Cutoff</div>
                  <Toggle label="" checked={hardCutoffEnabled} onChange={setHardCutoffEnabled} />
                </div>
                <div style={{ fontSize: 12, color: '#777', marginBottom: hardCutoffEnabled ? 10 : 0 }}>
                  Strict cutoff for this menu (typically holiday or pop-up ordering). The menu stays visible but is greyed out after this time.
                </div>
                {hardCutoffEnabled && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <div>
                      <label style={labelStyle}>Cutoff date</label>
                      <input type="date" style={inputStyle} value={hardCutoffDate} onChange={e => setHardCutoffDate(e.target.value)} />
                    </div>
                    <div>
                      <label style={labelStyle}>Cutoff time</label>
                      <TimeSelect style={inputStyle} value={hardCutoffTime} onChange={setHardCutoffTime} />
                    </div>
                  </div>
                )}
              </div>

              {/* Order limits */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Order limits</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={labelStyle}>Pickup minimum ($)</label>
                    <input type="number" min={0} step="0.01" style={inputStyle} value={pickupMin}
                      onChange={e => setPickupMin(parseFloat(e.target.value || '0'))} />
                  </div>
                  <div>
                    <label style={labelStyle}>Delivery minimum ($)</label>
                    <input type="number" min={0} step="0.01" style={inputStyle} value={deliveryMin}
                      onChange={e => setDeliveryMin(parseFloat(e.target.value || '0'))} />
                  </div>
                  <div>
                    <label style={labelStyle}>Max orders/day</label>
                    <input type="number" min={0} style={inputStyle} value={maxOrder}
                      onChange={e => setMaxOrder(e.target.value === '' ? '' : Math.max(0, parseInt(e.target.value, 10)))}
                      placeholder="No limit" />
                  </div>
                </div>
              </div>

              {/* Tips & Surcharges */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Tips &amp; surcharges</div>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Default tip</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {([10, 15, 20] as const).map(p => (
                      <ModeBtn key={p} active={tipMode === p} onClick={() => setTipMode(p)}>{p}%</ModeBtn>
                    ))}
                    <ModeBtn active={tipMode === 'CUSTOM'} onClick={() => setTipMode('CUSTOM')}>Custom</ModeBtn>
                  </div>
                  {tipMode === 'CUSTOM' && (
                    <div style={{ marginTop: 12, maxWidth: 220 }}>
                      <label style={labelStyle}>Custom default tip ($)</label>
                      <input type="number" min={0} step="0.01" style={inputStyle} value={customTip}
                        onChange={e => setCustomTip(e.target.value)} placeholder="0.00" />
                    </div>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={labelStyle}>Service charge (%)</label>
                    <input type="number" min={0} step="0.01" style={inputStyle} value={serviceCharge}
                      onChange={e => setServiceCharge(e.target.value)} placeholder="0" />
                  </div>
                  <div>
                    <label style={labelStyle}>Service charge name</label>
                    <input style={inputStyle} value={serviceChargeName}
                      onChange={e => setServiceChargeName(e.target.value)} placeholder="e.g. Service fee" />
                  </div>
                </div>
              </div>

              {/* Delivery fulfillment */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Delivery fulfillment</div>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Delivery method</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <ModeBtn active={deliveryType === 'OWN_DELIVERY'} onClick={() => setDeliveryType('OWN_DELIVERY')}>Self-Delivery</ModeBtn>
                    <ModeBtn active={deliveryType === 'NASH_DELIVERY'} onClick={() => setDeliveryType('NASH_DELIVERY')}>Third-Party</ModeBtn>
                  </div>
                </div>

                {deliveryType === 'OWN_DELIVERY' ? (
                  <>
                    {/* Primary tier */}
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#666', margin: '4px 0 10px' }}>Primary radius</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16, alignItems: 'end' }}>
                      <div>
                        <label style={labelStyle}>Radius (miles)</label>
                        <input type="number" min={0} step="0.1" style={inputStyle} value={ownRadius}
                          onChange={e => setOwnRadius(e.target.value)} placeholder="e.g. 5" />
                      </div>
                      <FeeInput
                        mode={ownFeeMode} onMode={setOwnFeeMode}
                        amount={ownFee} onAmount={setOwnFee}
                        percent={ownFeePercent} onPercent={setOwnFeePercent}
                        inputStyle={inputStyle} labelStyle={labelStyle}
                      />
                    </div>
                    {/* Secondary tier */}
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#666', margin: '4px 0 10px' }}>Secondary radius (optional)</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignItems: 'end' }}>
                      <div>
                        <label style={labelStyle}>Radius (miles)</label>
                        <input type="number" min={0} step="0.1" style={inputStyle} value={secRadius}
                          onChange={e => setSecRadius(e.target.value)} placeholder="e.g. 10" />
                      </div>
                      <FeeInput
                        mode={secFeeMode} onMode={setSecFeeMode}
                        amount={secFee} onAmount={setSecFee}
                        percent={secFeePercent} onPercent={setSecFeePercent}
                        inputStyle={inputStyle} labelStyle={labelStyle}
                      />
                    </div>
                  </>
                ) : (
                  <div style={{ maxWidth: 260 }}>
                    <label style={labelStyle}>Third-party subsidy (%)</label>
                    <input type="number" min={0} max={100} step="0.1" style={inputStyle} value={thirdPartySubsidy}
                      onChange={e => setThirdPartySubsidy(e.target.value)} placeholder="20" />
                    <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                      Percentage of the third-party delivery fee the restaurant covers (FM default 20%).
                    </div>
                  </div>
                )}
              </div>

              {/* Scheduling override */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Menu scheduling override</div>
                <div style={{ fontSize: 12, color: '#777', marginBottom: 12 }}>
                  Block out specific dates (holidays, closures). Each can be closed all day or limited to a custom window.
                </div>
                <SkippedDaysEditor value={skippedDays} onChange={setSkippedDays} inputStyle={inputStyle} labelStyle={labelStyle} />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 22px',
          borderTop: '1px solid #ececf2', background: '#fff', flexShrink: 0,
        }}>
          <button onClick={onClose} disabled={saving}
            style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving || loading}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: (saving || loading) ? 0.6 : 1 }}>
            {saving ? 'Saving…' : (isNew ? 'Create Menu' : 'Save settings')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: F, fontSize: 13, color: DARK }}>
      <span style={{
        width: 38, height: 22, borderRadius: 11, background: checked ? INDIGO : '#d6d6e0',
        position: 'relative', transition: 'background 0.15s', flexShrink: 0,
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 18 : 2, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
        }} />
      </span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ display: 'none' }} />
      {label}
    </label>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px',
      borderRadius: 8, border: '1.5px solid ' + (checked ? INDIGO : '#e0e0e0'),
      background: checked ? 'rgba(107,110,249,0.08)' : '#fff', cursor: 'pointer',
      fontFamily: F, fontSize: 13, fontWeight: 600, color: checked ? INDIGO : '#555',
    }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: INDIGO }} />
      {label}
    </label>
  )
}

function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
        border: '1.5px solid ' + (active ? INDIGO : '#e0e0e0'),
        background: active ? INDIGO : '#fff',
        color: active ? '#fff' : '#555', cursor: 'pointer', fontFamily: F,
      }}>{children}</button>
  )
}

function numOrNull(v: string): number | null {
  if (v == null || `${v}`.trim() === '') return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

// Delivery-fee input with a $/% segmented toggle. Mirrors FM's
// FAKE_OWN_DELIVERY_FEE_TYPES (currency=$, percentage=%): exactly one mode is
// active, and the inactive field is nulled on save.
function FeeInput({ mode, onMode, amount, onAmount, percent, onPercent, inputStyle, labelStyle }: {
  mode: 'currency' | 'percentage'
  onMode: (m: 'currency' | 'percentage') => void
  amount: string; onAmount: (v: string) => void
  percent: string; onPercent: (v: string) => void
  inputStyle: React.CSSProperties; labelStyle: React.CSSProperties
}) {
  const segBase: React.CSSProperties = { padding: '0 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', fontFamily: F }
  return (
    <div>
      <label style={labelStyle}>Delivery fee</label>
      <div style={{ display: 'flex' }}>
        <div style={{ display: 'flex', border: '1.5px solid #e0e0e0', borderRight: 'none', borderRadius: '8px 0 0 8px', overflow: 'hidden' }}>
          <button type="button" onClick={() => onMode('currency')}
            style={{ ...segBase, background: mode === 'currency' ? INDIGO : '#fff', color: mode === 'currency' ? '#fff' : '#777' }}>$</button>
          <button type="button" onClick={() => onMode('percentage')}
            style={{ ...segBase, background: mode === 'percentage' ? INDIGO : '#fff', color: mode === 'percentage' ? '#fff' : '#777' }}>%</button>
        </div>
        {mode === 'currency' ? (
          <input type="number" min={0} step="0.01" value={amount} onChange={e => onAmount(e.target.value)}
            placeholder="0.00" style={{ ...inputStyle, borderRadius: '0 8px 8px 0' }} />
        ) : (
          <input type="number" min={0} step="0.001" value={percent} onChange={e => onPercent(e.target.value)}
            placeholder="0" style={{ ...inputStyle, borderRadius: '0 8px 8px 0' }} />
        )}
      </div>
    </div>
  )
}

// Skipped-days editor. Each entry mirrors FM's skipped-day shape
// ({ name, fromDate, toDate, intervals: [{ fromTime, toTime }] }):
// intervals is empty for a full-day closure, or one entry for a custom window
// (skipped-days-modal.component.ts:89-108).
function SkippedDaysEditor({ value, onChange, inputStyle, labelStyle }: {
  value: SkippedDay[]; onChange: (v: SkippedDay[]) => void
  inputStyle: React.CSSProperties; labelStyle: React.CSSProperties
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [custom, setCustom] = useState(false)
  const [fromTime, setFromTime] = useState('09:00')
  const [toTime, setToTime] = useState('17:00')

  function reset() { setName(''); setFrom(''); setTo(''); setCustom(false); setFromTime('09:00'); setToTime('17:00'); setAdding(false) }
  function add() {
    if (!name.trim() || !from || !to) return
    const entry: SkippedDay = {
      name: name.trim(), fromDate: from, toDate: to,
      intervals: custom ? [{ fromTime, toTime }] : [],
    }
    onChange([...value, entry])
    reset()
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {value.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', border: '1px solid #eee', borderRadius: 8, marginBottom: 6, background: '#fafafe' }}>
              <div style={{ fontSize: 13, color: DARK }}>
                <span style={{ fontWeight: 600 }}>{d.name}</span>
                <span style={{ color: '#888' }}> · {d.fromDate}{d.toDate !== d.fromDate ? ` → ${d.toDate}` : ''} · {d.intervals.length ? `${normalizeTime(d.intervals[0].fromTime)}–${normalizeTime(d.intervals[0].toTime)}` : 'Closed all day'}</span>
              </div>
              <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#E24B4A', fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div style={{ border: '1px dashed #d8d8e4', borderRadius: 10, padding: 14 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Name</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Thanksgiving" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div><label style={labelStyle}>From date</label><input type="date" style={inputStyle} value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div><label style={labelStyle}>To date</label><input type="date" style={inputStyle} value={to} onChange={e => setTo(e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: custom ? 12 : 0 }}>
            <ModeBtn active={!custom} onClick={() => setCustom(false)}>Closed all day</ModeBtn>
            <ModeBtn active={custom} onClick={() => setCustom(true)}>Custom hours</ModeBtn>
          </div>
          {custom && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label style={labelStyle}>From</label><TimeSelect style={inputStyle} value={fromTime} onChange={setFromTime} /></div>
              <div><label style={labelStyle}>To</label><TimeSelect style={inputStyle} value={toTime} onChange={setToTime} /></div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button type="button" onClick={add} disabled={!name.trim() || !from || !to}
              style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: (!name.trim() || !from || !to) ? 0.5 : 1 }}>Add</button>
            <button type="button" onClick={reset}
              style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          style={{ background: 'transparent', border: '1.5px solid ' + INDIGO, borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: INDIGO }}>+ Add override</button>
      )}
    </div>
  )
}
