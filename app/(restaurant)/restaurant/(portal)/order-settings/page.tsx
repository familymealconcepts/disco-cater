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
}

interface FeesAndTips {
  businessNameWithoutSpaces?: string
  announcement?: string
  deliveryOrderTimeWindows?: 'exact' | '30_min' | '1_hour'
  enableMenuSearch?: boolean
}

interface ClosedDay {
  reference: string
  name: string
  available: boolean
  dateString?: string
  custom?: boolean
}

interface Coupon {
  reference?: string
  code: string
  maxAvailable: number
  maxPerDiner: number
  discountPercentage: number
  startDate: string
  endDate: string
  remainingAvailable?: number
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OrderSettingsPage() {
  const [restaurant, setRestaurant] = useState<{ reference?: string; onlineOrderingAllowed?: boolean; businessNameWithoutSpaces?: string } | null>(null)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [notifications, setNotifications] = useState<Notifications | null>(null)
  const [feesAndTips, setFeesAndTips] = useState<FeesAndTips | null>(null)
  const [closedDays, setClosedDays] = useState<ClosedDay[]>([])
  const [coupon, setCoupon] = useState<Coupon | null>(null)
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

  // Coupon form
  const [couponForm, setCouponForm] = useState<Partial<Coupon>>({})
  const [couponDirty, setCouponDirty] = useState(false)

  // New closed day
  const [newClosedDate, setNewClosedDate] = useState('')

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const loadAll = useCallback(async () => {
    const [rest, notif, fees, closed, coup] = await Promise.all([
      fetch('/api/restaurant/profile').then(r => r.ok ? r.json() : {}) as Promise<typeof restaurant>,
      fetch('/api/restaurant/notifications').then(r => r.ok ? r.json() : null) as Promise<Notifications | null>,
      fetch('/api/restaurant/fees-and-tips').then(r => r.ok ? r.json() : {}) as Promise<FeesAndTips>,
      fetch('/api/restaurant/closed-days').then(r => r.ok ? r.json() : []) as Promise<ClosedDay[]>,
      fetch('/api/restaurant/coupon').then(r => r.ok ? r.json() : null) as Promise<Coupon | null>,
    ])
    setRestaurant(rest)
    setNotifications(notif)
    setFeesAndTips(fees)
    setClosedDays(Array.isArray(closed) ? closed : [])
    setCoupon(coup)
    if (coup) setCouponForm(coup)
    if (fees?.announcement) setAnnouncement(fees.announcement)
    if (fees?.businessNameWithoutSpaces) setUrlSlug(fees.businessNameWithoutSpaces)

    if (rest?.reference) {
      fetch(`/api/restaurant/stripe-status?ref=${rest.reference}`)
        .then(r => r.ok ? r.json() : { connected: false })
        .then(d => setStripeConnected(d.connected))
    }
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
    await fetch(`/api/restaurant/online-ordering?onlineOrderingAllowed=${val}`, { method: 'PATCH' })
    setRestaurant(prev => prev ? { ...prev, onlineOrderingAllowed: val } : prev)
    showToast('Saved')
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
    const res = await fetch('/api/restaurant/closed-days', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dateString: newClosedDate, available: false, custom: true }) })
    if (res.ok) { setNewClosedDate(''); loadAll() }
  }

  async function deleteClosedDay(ref: string) {
    await fetch(`/api/restaurant/closed-days/${ref}`, { method: 'DELETE' })
    setClosedDays(prev => prev.filter(d => d.reference !== ref))
  }

  async function saveCoupon() {
    const method = coupon?.reference ? 'PUT' : 'POST'
    const res = await fetch('/api/restaurant/coupon', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(couponForm) })
    if (res.ok) { setCouponDirty(false); loadAll(); showToast('Coupon saved') }
  }

  async function endCoupon() {
    await fetch('/api/restaurant/coupon', { method: 'DELETE' })
    setCoupon(null)
    setCouponForm({})
    showToast('Coupon ended')
  }

  if (loading) return <div style={{ padding: 40, color: '#aaa', fontFamily: F }}>Loading…</div>

  const systemDays = closedDays.filter(d => !d.custom)
  const customDays = closedDays.filter(d => d.custom)

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
          <Toggle checked={restaurant?.onlineOrderingAllowed ?? false} onChange={toggleOnlineOrdering} />
        </Row>
        {!stripeConnected && (
          <p style={{ fontSize: 12, color: '#E76F51', margin: 0 }}>Stripe must be connected in Banking to enable online ordering.</p>
        )}
      </Section>

      {/* Page URL */}
      <Section title="Disco Cater Page URL">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#888' }}>discocater.com/</span>
          <input
            value={urlSlug}
            onChange={e => { setUrlSlug(e.target.value.toLowerCase()); setUrlSlugDirty(true) }}
            pattern="^[A-Za-z0-9-_]+$"
            style={{ ...inputStyle, minWidth: 180 }}
          />
          {urlSlugDirty && (
            <button onClick={() => { saveFeesAndTips({ businessNameWithoutSpaces: urlSlug }); setUrlSlugDirty(false) }}
              style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
              Save
            </button>
          )}
        </div>
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
            <Row label="Print Kitchen Tickets">
              <Toggle checked={notifications.autoPrint} onChange={v => saveNotifications({ ...notifications, autoPrint: v })} />
            </Row>
          </div>
        </Section>
      )}

      {/* Delivery Order Time Windows */}
      {feesAndTips && (
        <Section title="Delivery & Display Settings">
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
          <Row label="Enable Menu Search">
            <Toggle checked={feesAndTips.enableMenuSearch ?? false} onChange={v => saveFeesAndTips({ enableMenuSearch: v })} />
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
        <div style={{ marginBottom: 16 }}>
          {systemDays.map(day => (
            <Row key={day.reference} label={day.name}>
              <Toggle checked={day.available} onChange={() => toggleClosedDay(day)} />
            </Row>
          ))}
        </div>
        {customDays.length > 0 && (
          <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 10 }}>Custom Dates</div>
            {customDays.map(day => (
              <div key={day.reference} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#555' }}>{day.dateString || day.name}</span>
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

      {/* Coupon */}
      <Section title="Discounts / Coupon">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {[
            { label: 'Discount Name', field: 'code', type: 'text' },
            { label: 'Total Discounts Available', field: 'maxAvailable', type: 'number' },
            { label: 'Total Per Diner', field: 'maxPerDiner', type: 'number' },
            { label: 'Discount %', field: 'discountPercentage', type: 'number' },
            { label: 'Start Date', field: 'startDate', type: 'date' },
            { label: 'End Date', field: 'endDate', type: 'date' },
          ].map(({ label, field, type }) => (
            <div key={field}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5 }}>{label}</label>
              <input
                type={type}
                value={(couponForm as Record<string, unknown>)[field] as string | number || ''}
                onChange={e => { setCouponForm(prev => ({ ...prev, [field]: type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value })); setCouponDirty(true) }}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button
            onClick={saveCoupon}
            disabled={!couponDirty || saving}
            style={{ padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: couponDirty ? 'pointer' : 'not-allowed', opacity: couponDirty ? 1 : 0.5, fontFamily: F }}
          >
            {coupon?.reference ? 'Update Coupon' : 'Create Coupon'}
          </button>
          {coupon?.reference && (
            <button onClick={endCoupon}
              style={{ padding: '9px 18px', background: '#fff', color: '#E76F51', border: '1px solid #E76F51', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
              End Coupon
            </button>
          )}
        </div>
      </Section>
    </div>
  )
}
