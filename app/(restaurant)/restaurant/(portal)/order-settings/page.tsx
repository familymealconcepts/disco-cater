'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Notifications {
  email: string[]
  phoneNumber: string[]
  emailNotificationType: 'ALL' | 'ORDERS_ONLY' | 'OFF'
  phoneNotificationType: 'ALL' | 'OFF'
  autoPrint: boolean
  orderReminderEmailsEnabled: boolean
  adminOrderReminderEmailsEnabled: boolean
  // Disco-native restaurants serve this section from Neon (the FM call would 401).
  // Used to hide the legacy single-phone SMS section for them (the multi-phone
  // list below now covers it). Absent/false for FM-token restaurants.
  discoNative?: boolean
}

interface FeesAndTips {
  businessNameWithoutSpaces?: string
  announcement?: string
  deliveryOrderTimeWindows?: 'exact' | '30_min' | '1_hour'
  enableMenuSearch?: boolean
}

interface ClosedDay {
  reference: string
  eventName: string
  available: boolean
  eventDates?: string[]
}

const SYSTEM_HOLIDAYS = [
  'Christmas Day', 'Christmas Eve', 'July 4th', 'Labor Day',
  'Memorial Day', "New Year's Day", "New Year's Eve",
  'Thanksgiving Day', "Valentine's Day", 'Martin Luther King Jr. Day',
  "President's Day", 'Independence Day', 'Easter',
]
const isSystemHoliday = (d: ClosedDay) => SYSTEM_HOLIDAYS.includes(d.eventName)
const formatEventDates = (dates?: string[]) => {
  if (!dates?.length) return ''
  if (dates.length === 1) return dates[0]
  return `${dates[0]} – ${dates[dates.length - 1]}`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        width: 44, height: 24, borderRadius: 12, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? BLUE : '#ddd', position: 'relative', transition: 'background 0.2s', opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: checked ? 23 : 3, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left 0.2s', display: 'block',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '24px 28px', border: '1px solid #eee', marginBottom: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: DARK, margin: '0 0 18px' }}>{title}</h2>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <span style={{ fontSize: 13, color: '#555' }}>{label}</span>
      <div>{children}</div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px',
  fontSize: 13, fontFamily: F, outline: 'none', color: DARK, background: '#fff',
}

// Slug rules: lowercase, alphanumeric + hyphens only, 3–60 chars.
// Same shape FM accepts on businessNameWithoutSpaces but with our spec's
// length bounds added so the UI can surface the error early.
function slugValidationError(s: string): string | null {
  if (!s) return null
  if (s.length < 3) return 'Slug must be at least 3 characters'
  if (s.length > 60) return 'Slug must be at most 60 characters'
  if (!/^[a-z0-9-]+$/.test(s)) return 'Slug can only contain lowercase letters, numbers, and hyphens'
  if (s.startsWith('-') || s.endsWith('-')) return 'Slug cannot start or end with a hyphen'
  return null
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OrderSettingsPage() {
  const [restaurant, setRestaurant] = useState<{ reference?: string; onlineOrderingAllowed?: boolean; businessNameWithoutSpaces?: string } | null>(null)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [marketplaceVisible, setMarketplaceVisible] = useState(false)
  // Canonical "Accept online orders" flag (disco_restaurant_overrides
  // .online_ordering_enabled) — the SAME field the order gate + super-admin read.
  // Previously this page read profile.onlineOrderingAllowed, which native
  // restaurants never populate, so the checkbox was decoupled from reality.
  const [onlineOrderingEnabled, setOnlineOrderingEnabled] = useState(false)
  const [notifications, setNotifications] = useState<Notifications | null>(null)
  const [feesAndTips, setFeesAndTips] = useState<FeesAndTips | null>(null)
  const [closedDays, setClosedDays] = useState<ClosedDay[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  // Email / phone input fields
  const [newEmail, setNewEmail] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [announcementDirty, setAnnouncementDirty] = useState(false)
  const [urlSlug, setUrlSlug] = useState('')
  const [urlSlugDirty, setUrlSlugDirty] = useState(false)
  const [urlSlugError, setUrlSlugError] = useState<string | null>(null)

  // New closed day
  const [newClosedDate, setNewClosedDate] = useState('')

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const loadAll = useCallback(async () => {
    const [rest, notif, fees, closed] = await Promise.all([
      fetch('/api/restaurant/profile').then(r => r.ok ? r.json() : {}) as Promise<typeof restaurant>,
      fetch('/api/restaurant/notifications').then(r => r.ok ? r.json() : null) as Promise<Notifications | null>,
      fetch('/api/restaurant/fees-and-tips').then(r => r.ok ? r.json() : {}) as Promise<FeesAndTips>,
      fetch('/api/restaurant/closed-days').then(r => r.ok ? r.json() : []) as Promise<ClosedDay[]>,
    ])
    setRestaurant(rest)
    setNotifications(notif)
    setFeesAndTips(fees)
    setClosedDays(Array.isArray(closed) ? closed : [])
    if (fees?.announcement) setAnnouncement(fees.announcement)
    if (fees?.businessNameWithoutSpaces) setUrlSlug(fees.businessNameWithoutSpaces)

    if (rest?.reference) {
      fetch(`/api/restaurant/stripe-status?ref=${rest.reference}`)
        .then(r => r.ok ? r.json() : { connected: false })
        .then(d => setStripeConnected(d.connected))
    }
    fetch('/api/restaurant/marketplace-visibility')
      .then(r => r.ok ? r.json() : { visible: false })
      .then(d => setMarketplaceVisible(!!d.visible))
      .catch(() => {})
    // Canonical online-ordering flag (default ON when unset, matching the order
    // gate's COALESCE(online_ordering_enabled, true)).
    fetch('/api/restaurant/disco-settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => setOnlineOrderingEnabled(d?.settings?.online_ordering_enabled !== false))
      .catch(() => {})
    setLoading(false)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  async function saveNotifications(updated: Notifications) {
    setSaving(true)
    await fetch('/api/restaurant/notifications', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated) })
    setNotifications(updated)
    setSaving(false)
    showToast('Saved')
  }

  async function saveFeesAndTips(patch: Partial<FeesAndTips>) {
    const merged = { ...feesAndTips, ...patch }
    await fetch('/api/restaurant/fees-and-tips', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged) })
    setFeesAndTips(merged)
    showToast('Saved')
  }

  async function toggleOnlineOrdering(val: boolean) {
    if (val && !stripeConnected) { showToast('Stripe must be connected to enable online ordering.'); return }
    // restaurant_reference sourced from the profile GET captured into `restaurant`
    // state at load — NOT the live selected-restaurant context — so a mid-edit
    // restaurant switch can't silently retarget this write.
    await fetch(`/api/restaurant/online-ordering?onlineOrderingAllowed=${val}&restaurant_reference=${encodeURIComponent(restaurant?.reference || '')}`, { method: 'PATCH' })
    setOnlineOrderingEnabled(val)
    setRestaurant(prev => prev ? { ...prev, onlineOrderingAllowed: val } : prev)
    showToast('Saved')
  }

  // Disco Cater Marketplace visibility → disco_restaurant_overrides.visible
  // (drives whether the restaurant appears on the public fullmap discovery map).
  async function toggleMarketplace(val: boolean) {
    setMarketplaceVisible(val)
    try {
      const res = await fetch('/api/restaurant/marketplace-visibility', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurant_reference: restaurant?.reference, visible: val }),
      })
      if (!res.ok) { setMarketplaceVisible(!val); showToast('Could not update marketplace visibility.'); return }
      showToast('Saved')
    } catch {
      setMarketplaceVisible(!val); showToast('Could not update marketplace visibility.')
    }
  }

  function addEmail() {
    if (!newEmail || !notifications) return
    const updated = { ...notifications, email: [...notifications.email, newEmail.trim()] }
    setNewEmail('')
    saveNotifications(updated)
  }

  function removeEmail(e: string) {
    if (!notifications) return
    saveNotifications({ ...notifications, email: notifications.email.filter(x => x !== e) })
  }

  function addPhone() {
    if (!newPhone || !notifications) return
    const updated = { ...notifications, phoneNumber: [...notifications.phoneNumber, newPhone.trim()] }
    setNewPhone('')
    saveNotifications(updated)
  }

  function removePhone(p: string) {
    if (!notifications) return
    saveNotifications({ ...notifications, phoneNumber: notifications.phoneNumber.filter(x => x !== p) })
  }

  async function toggleClosedDay(day: ClosedDay) {
    await fetch(`/api/restaurant/closed-days/${day.reference}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...day, available: !day.available }),
    })
    setClosedDays(prev => prev.map(d => d.reference === day.reference ? { ...d, available: !d.available } : d))
  }

  async function addClosedDay() {
    if (!newClosedDate) return
    const [y, m, d] = newClosedDate.split('-')
    const eventDate = `${d}.${m}.${y}`
    const res = await fetch('/api/restaurant/closed-days', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ available: true, eventName: eventDate, eventDates: [eventDate] }),
    })
    if (res.ok) { setNewClosedDate(''); loadAll() }
  }

  async function deleteClosedDay(ref: string) {
    await fetch(`/api/restaurant/closed-days/${ref}`, { method: 'DELETE' })
    setClosedDays(prev => prev.filter(d => d.reference !== ref))
  }


  if (loading) return <div style={{ padding: 40, color: '#aaa', fontFamily: F }}>Loading…</div>

  const systemDays = closedDays.filter(isSystemHoliday)
  const customDays = closedDays.filter(d => !isSystemHoliday(d))

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 720 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 24px' }}>Settings</h1>

      {toast && (
        <div style={{ position: 'fixed', top: 24, right: 24, background: '#22C55E', color: '#fff', borderRadius: 10, padding: '12px 20px', fontSize: 13, fontWeight: 600, zIndex: 999, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
          {toast}
        </div>
      )}

      {/* Online Ordering */}
      <Section title="Online Ordering">
        <Row label="Accept online orders">
          <Toggle checked={onlineOrderingEnabled} onChange={toggleOnlineOrdering} />
        </Row>
        {!stripeConnected && (
          <p style={{ fontSize: 12, color: '#E76F51', margin: 0 }}>Stripe must be connected in Banking to enable online ordering.</p>
        )}
      </Section>

      {/* Public Page URL — primary Disco Cater URL with secondary FM ref */}
      <Section title="Public Page URL">
        <p style={{ fontSize: 12, color: '#777', margin: '0 0 14px', lineHeight: 1.55 }}>
          The link customers use to find your menu on Disco Cater. Slug must be lowercase, letters/numbers/hyphens only, 3–60 characters, and unique across all restaurants.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#888', whiteSpace: 'nowrap' }}>https://www.discocater.com/order/</span>
          <input
            value={urlSlug}
            onChange={e => {
              const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
              setUrlSlug(v)
              setUrlSlugDirty(v !== (feesAndTips?.businessNameWithoutSpaces || ''))
              setUrlSlugError(slugValidationError(v))
            }}
            placeholder="my-restaurant"
            minLength={3}
            maxLength={60}
            style={{ ...inputStyle, minWidth: 180, borderColor: urlSlugError ? '#E76F51' : '#e0e0e0' }}
          />

          {/* External link — opens the live page */}
          {urlSlug && !urlSlugDirty && (
            <a
              href={`https://www.discocater.com/order/${urlSlug}`}
              target="_blank" rel="noreferrer"
              title="Open public page in new tab"
              style={{ color: BLUE, fontSize: 16, lineHeight: 1, padding: '8px 10px', textDecoration: 'none', border: '1px solid #e8e8e8', borderRadius: 8 }}
            >↗</a>
          )}

          {/* Copy to clipboard */}
          {urlSlug && !urlSlugDirty && (
            <button
              onClick={() => {
                navigator.clipboard?.writeText(`https://www.discocater.com/order/${urlSlug}`)
                showToast('URL copied')
              }}
              title="Copy URL"
              style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', fontSize: 13, color: '#555', fontFamily: F }}
            >⧉</button>
          )}

          {urlSlugDirty && (
            <button
              onClick={() => {
                if (urlSlugError) return
                saveFeesAndTips({ businessNameWithoutSpaces: urlSlug })
                setUrlSlugDirty(false)
              }}
              disabled={!!urlSlugError}
              style={{ padding: '8px 14px', background: urlSlugError ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: urlSlugError ? 'not-allowed' : 'pointer', fontFamily: F }}
            >
              Save
            </button>
          )}
        </div>

        {urlSlugError && (
          <p style={{ fontSize: 12, color: '#E76F51', margin: '6px 0 0' }}>{urlSlugError}</p>
        )}
      </Section>

      {/* Notifications */}
      {notifications && (
        <Section title="Notifications">
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 10 }}>Email Notifications</div>
            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
              {(['ALL', 'ORDERS_ONLY', 'OFF'] as const).map(v => (
                <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#555' }}>
                  <input type="radio" name="emailType" value={v} checked={notifications.emailNotificationType === v}
                    onChange={() => saveNotifications({ ...notifications, emailNotificationType: v })} />
                  {v === 'ALL' ? 'All' : v === 'ORDERS_ONLY' ? 'Orders Only' : 'Off'}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {notifications.email.map(e => (
                <div key={e} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#F0F0F4', borderRadius: 6, padding: '4px 10px' }}>
                  <span style={{ fontSize: 12, color: DARK }}>{e}</span>
                  <button onClick={() => removeEmail(e)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 14, lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="email" placeholder="Add email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addEmail()}
                style={{ ...inputStyle, minWidth: 220 }} />
              <button onClick={addEmail} style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: F }}>Add</button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16, marginBottom: 16 }}>
            <Row label="Text Notifications">
              <Toggle checked={notifications.phoneNotificationType === 'ALL'} onChange={v => saveNotifications({ ...notifications, phoneNotificationType: v ? 'ALL' : 'OFF' })} />
            </Row>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {notifications.phoneNumber.map(p => (
                <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#F0F0F4', borderRadius: 6, padding: '4px 10px' }}>
                  <span style={{ fontSize: 12, color: DARK }}>{p}</span>
                  <button onClick={() => removePhone(p)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 14, lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="tel" placeholder="000-000-0000" value={newPhone} onChange={e => setNewPhone(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addPhone()}
                style={{ ...inputStyle, minWidth: 160 }} />
              <button onClick={addPhone} style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: F }}>Add</button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16 }}>
            <Row label="Customer Order Reminder Emails">
              <Toggle checked={notifications.orderReminderEmailsEnabled} onChange={v => saveNotifications({ ...notifications, orderReminderEmailsEnabled: v })} />
            </Row>
            <Row label="Restaurant Order Reminder Emails">
              <Toggle checked={notifications.adminOrderReminderEmailsEnabled} onChange={v => saveNotifications({ ...notifications, adminOrderReminderEmailsEnabled: v })} />
            </Row>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: -4 }}>
              Sent ~24 hours before the order. <strong>Customer</strong> reminders email the diner; <strong>Restaurant</strong> reminders email your team (the notification recipients above).
            </div>
            {/* "Print Kitchen Tickets" (autoPrint) toggle intentionally hidden from
                the UI — the field is still round-tripped to FM on every save (kept
                in the Notifications interface + saveNotifications payload). */}
          </div>
        </Section>
      )}

      {/* Delivery Order Time Windows */}
      {feesAndTips && (
        <Section title="Delivery & Display Settings">
          <Row label="Enable Menu Search">
            <Toggle checked={feesAndTips.enableMenuSearch ?? false} onChange={v => saveFeesAndTips({ enableMenuSearch: v })} />
          </Row>
          <Row label="Delivery Order Time Windows">
            <select
              value={feesAndTips.deliveryOrderTimeWindows || 'exact'}
              onChange={e => saveFeesAndTips({ deliveryOrderTimeWindows: e.target.value as 'exact' | '30_min' | '1_hour' })}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="exact">Exact</option>
              <option value="30_min">30 Minutes</option>
              <option value="1_hour">1 Hour</option>
            </select>
          </Row>
        </Section>
      )}

      {/* Announcement Banner */}
      <Section title="Announcement Banner">
        <textarea
          value={announcement}
          onChange={e => { setAnnouncement(e.target.value); setAnnouncementDirty(true) }}
          maxLength={500}
          rows={3}
          placeholder="Show a message to customers on your menu page…"
          style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 11, color: '#bbb' }}>{announcement.length}/500</span>
          {announcementDirty && (
            <button onClick={() => { saveFeesAndTips({ announcement }); setAnnouncementDirty(false) }}
              style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
              Save
            </button>
          )}
        </div>
      </Section>

      {/* Scheduling Override */}
      <Section title="Scheduling Override (Closed Days)">
        <p style={{ fontSize: 12, color: '#777', margin: '0 0 14px', lineHeight: 1.55 }}>
          Toggle holidays you're closed on. Add custom dates below for one-off closures.
        </p>
        {/* Two-column holiday grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 24, rowGap: 4, marginBottom: 16 }}>
          {systemDays.map(day => (
            <div key={day.reference} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: '#555' }}>{day.eventName}</span>
              <Toggle checked={day.available} onChange={() => toggleClosedDay(day)} />
            </div>
          ))}
        </div>
        {customDays.length > 0 && (
          <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 10 }}>Custom Dates</div>
            {customDays.map(day => (
              <div key={day.reference} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#555' }}>{day.eventName || formatEventDates(day.eventDates)}</span>
                <button onClick={() => deleteClosedDay(day.reference)}
                  style={{ background: 'none', border: 'none', color: '#E76F51', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input type="date" value={newClosedDate} onChange={e => setNewClosedDate(e.target.value)}
            style={{ ...inputStyle }} />
          <button onClick={addClosedDay} disabled={!newClosedDate}
            style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: F, opacity: newClosedDate ? 1 : 0.5 }}>
            Add Date
          </button>
        </div>
      </Section>

      {/* Disco Cater Marketplace — not part of the core General Settings list; kept
          at the bottom (fullmap discovery-map visibility). */}
      <Section title="Disco Cater Marketplace">
        <Row label="Show your restaurant on the Disco Cater discovery map">
          <Toggle checked={marketplaceVisible} onChange={toggleMarketplace} />
        </Row>
      </Section>

    </div>
  )
}
