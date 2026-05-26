'use client'
import { useEffect, useMemo, useState } from 'react'

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
  deliveryType?: 'OWN_DELIVERY' | 'THIRD_PARTY'
  ownDeliveryRadius?: number
  ownDeliveryFee?: number
  ownDeliveryFeePercent?: number
  secondaryOwnDeliveryRadius?: number
  secondaryOwnDeliveryFee?: number
  secondaryOwnDeliveryFeePercent?: number
  thirdPartyDeliverySubsidingPercent?: number
  serviceCharge?: number
  serviceChargeName?: string
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
const DAY_LABELS: Record<DayKey, string> = {
  MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed', THURSDAY: 'Thu',
  FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun',
}

const MENU_TYPES = [
  { v: 'FAMILY_MEAL', label: 'Family Meal' },
  { v: 'CATERING', label: 'Catering' },
  { v: 'KITS', label: 'Kits' },
  { v: 'BEVERAGES', label: 'Beverages' },
  { v: 'PANTRY', label: 'Pantry' },
  { v: 'CHEFS_TABLE', label: "Chef's Table" },
  { v: 'POPUP', label: 'Pop Up' },
  { v: 'COLLABS', label: 'Collabs' },
  { v: 'DRINKS', label: 'Drinks' },
  { v: 'SERIES', label: 'Series' },
]

interface Props {
  menuRef: string
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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [menu, setMenu] = useState<FullMenu | null>(null)

  // form state
  const [name, setName] = useState('')
  const [type, setType] = useState('FAMILY_MEAL')
  const [url, setUrl] = useState('')
  const [visible, setVisible] = useState(true)
  const [archived, setArchived] = useState(false)

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
  const [prepDays, setPrepDays] = useState(1)
  const [prepHours, setPrepHours] = useState(0)
  const [cutOffType, setCutOffType] = useState<'DAILY' | 'BY_DATE' | ''>('DAILY')
  const [cutOff, setCutOff] = useState('17:00')
  const [cutOffDate, setCutOffDate] = useState('')

  // minimums
  const [pickupMin, setPickupMin] = useState(0)
  const [deliveryMin, setDeliveryMin] = useState(0)
  const [maxOrder, setMaxOrder] = useState<number | ''>('')

  // ── load menu ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancel = false
    setLoading(true); setErr(null)
    fetch(`/api/restaurant/menus/${menuRef}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Load failed (${r.status})`)))
      .then((m: FullMenu) => {
        if (cancel) return
        setMenu(m)
        setName(m.name || '')
        setType(m.type || m.menuType || 'FAMILY_MEAL')
        setUrl(m.url || '')
        setVisible(m.visible !== false)
        setArchived(!!m.archived)

        const sched = m.scheduleOption || emptyScheduleOption()
        const settings = m.settings || emptySettings()

        const avail = settings.menuAvailability || []
        setPickup(avail.includes('PICKUP'))
        setDelivery(avail.includes('DELIVERY'))

        setScheduleType(sched.scheduleType || 'SAME_DAY')
        setRollingAvailability(sched.rollingAvailability ?? 30)
        const totalHours = Math.max(0, Math.floor(sched.prepTime ?? 24))
        setPrepDays(Math.floor(totalHours / 24))
        setPrepHours(totalHours % 24)
        setCutOffType((sched.cutOffType as 'DAILY' | 'BY_DATE') || 'DAILY')
        setCutOff(sched.cutOff || '17:00')
        setCutOffDate(sched.cutOffDate || '')

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
              perMap[d] = { from: w.fromPickUpTime || '11:00', to: w.toPickUpTime || '19:00' }
              if (!firstFrom) { firstFrom = w.fromPickUpTime || ''; firstTo = w.toPickUpTime || '' }
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
    if (scheduleType === 'SAME_DAY') {
      return [{ days: activeDays.join(','), fromPickUpTime: sameDayFrom, toPickUpTime: sameDayTo }]
    }
    return activeDays.map(d => ({ days: d, fromPickUpTime: perDay[d].from, toPickUpTime: perDay[d].to }))
  }

  async function save() {
    if (!menu) return
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
        ...(menu.scheduleOption || emptyScheduleOption()),
        scheduleType,
        rollingAvailability,
        repeatWeekDays,
        prepTime: totalPrepHours,
        maxOrder: maxOrder === '' ? null : Number(maxOrder),
        cutOffType: cutOffType || undefined,
        cutOff: cutOffType === 'DAILY' ? cutOff : (menu.scheduleOption?.cutOff || undefined),
        cutOffDate: cutOffType === 'BY_DATE' ? cutOffDate : (menu.scheduleOption?.cutOffDate || undefined),
      }

      const settings: MenuSettings = {
        ...(menu.settings || emptySettings()),
        pickupOrderMinimum: Number(pickupMin) || 0,
        deliveryOrderMinimum: Number(deliveryMin) || 0,
        menuAvailability,
      }

      const body = {
        ...menu,
        name: name.trim(),
        type,
        url,
        scheduleOption,
        settings,
      }

      const putRes = await fetch(`/api/restaurant/menus/${menuRef}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!putRes.ok) throw new Error(`Save failed (${putRes.status})`)

      // Separate endpoints for visible/archive toggles.
      if (visible !== (menu.visible !== false)) {
        await fetch(`/api/restaurant/menus/${menuRef}/visible?isVisible=${visible}`, { method: 'PUT' })
      }
      if (archived !== !!menu.archived) {
        await fetch(`/api/restaurant/menus/${menuRef}/archive?isArchived=${archived}`, { method: 'PUT' })
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
            <div style={{ fontSize: 11, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Menu Settings</div>
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                  <div>
                    <label style={labelStyle}>Type</label>
                    <select style={inputStyle} value={type} onChange={e => setType(e.target.value)}>
                      {MENU_TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>URL slug</label>
                    <input style={inputStyle} value={url} onChange={e => setUrl(e.target.value)} placeholder="catering" />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Toggle label="Visible (active)" checked={visible} onChange={setVisible} />
                  <Toggle label="Archived" checked={archived} onChange={setArchived} />
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
                      <input type="time" style={inputStyle} value={sameDayFrom} onChange={e => setSameDayFrom(e.target.value)} />
                    </div>
                    <div>
                      <label style={labelStyle}>To</label>
                      <input type="time" style={inputStyle} value={sameDayTo} onChange={e => setSameDayTo(e.target.value)} />
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
                        <input type="time" style={inputStyle} value={perDay[d].from}
                          onChange={e => setPerDay(s => ({ ...s, [d]: { ...s[d], from: e.target.value } }))} />
                        <input type="time" style={inputStyle} value={perDay[d].to}
                          onChange={e => setPerDay(s => ({ ...s, [d]: { ...s[d], to: e.target.value } }))} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Lead time / cutoff */}
              <div style={sectionStyle}>
                <div style={sectionTitle}>Advance order &amp; cutoff</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
                  <div>
                    <label style={labelStyle}>Advance days</label>
                    <input type="number" min={0} style={inputStyle} value={prepDays}
                      onChange={e => setPrepDays(Math.max(0, parseInt(e.target.value || '0', 10)))} />
                  </div>
                  <div>
                    <label style={labelStyle}>Advance hours</label>
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

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={labelStyle}>Cutoff type</label>
                    <select style={inputStyle} value={cutOffType} onChange={e => setCutOffType(e.target.value as 'DAILY' | 'BY_DATE' | '')}>
                      <option value="DAILY">Daily cutoff time</option>
                      <option value="BY_DATE">By specific date</option>
                    </select>
                  </div>
                  <div>
                    {cutOffType === 'BY_DATE' ? (
                      <>
                        <label style={labelStyle}>Cutoff date</label>
                        <input type="date" style={inputStyle} value={cutOffDate} onChange={e => setCutOffDate(e.target.value)} />
                      </>
                    ) : (
                      <>
                        <label style={labelStyle}>Cutoff time</label>
                        <input type="time" style={inputStyle} value={cutOff} onChange={e => setCutOff(e.target.value)} />
                      </>
                    )}
                  </div>
                </div>
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
            {saving ? 'Saving…' : 'Save settings'}
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
