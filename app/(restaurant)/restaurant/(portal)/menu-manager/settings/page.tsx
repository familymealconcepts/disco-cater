'use client'
import { useEffect, useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface ClosedDay { reference: string; name: string | null; from_date: string; to_date: string }

// General Settings for Disco-native restaurants. Order matches the canonical
// General Settings list (top to bottom): Online Ordering, Disco Cater URL,
// Email Recipients, Text Notifications, Text Recipients, Customer Reminder,
// Restaurant Reminder, Enable Menu Search, Delivery Time Windows, Announcement
// Banner, Schedule Override. Stored in disco_restaurant_overrides via
// /api/restaurant/disco-settings — zero FM. (Tax lives on its own "Tax Rate" page.)
export default function RestaurantSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState('')

  const [slug, setSlug] = useState<string | null>(null)
  const [onlineOrdering, setOnlineOrdering] = useState(true)
  const [notificationEmails, setNotificationEmails] = useState('')
  const [textNotifications, setTextNotifications] = useState(false)
  const [notificationSms, setNotificationSms] = useState('')
  const [orderReminders, setOrderReminders] = useState(false)       // customer
  const [adminReminders, setAdminReminders] = useState(false)       // restaurant
  const [enableMenuSearch, setEnableMenuSearch] = useState(false)
  const [deliveryWindow, setDeliveryWindow] = useState<'exact' | '30_min' | '1_hour'>('exact')
  const [announcement, setAnnouncement] = useState('')

  const [closedDays, setClosedDays] = useState<ClosedDay[]>([])
  const [cdName, setCdName] = useState(''); const [cdFrom, setCdFrom] = useState(''); const [cdTo, setCdTo] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [s, c] = await Promise.all([
        fetch('/api/restaurant/disco-settings').then(r => r.json()),
        fetch('/api/restaurant/disco-closed-days').then(r => r.json()),
      ])
      const set = s.settings || {}
      setSlug(s.slug || null)
      setOnlineOrdering(set.online_ordering_enabled !== false)
      setNotificationEmails(set.notification_emails || '')
      setTextNotifications(set.text_notifications_enabled === true)
      setNotificationSms(set.notification_sms_numbers || '')
      setOrderReminders(set.order_reminder_emails_enabled === true)
      setAdminReminders(set.admin_order_reminder_emails_enabled === true)
      setEnableMenuSearch(set.enable_menu_search === true)
      setDeliveryWindow(set.delivery_order_time_windows || 'exact')
      setAnnouncement(set.announcement || '')
      setClosedDays(Array.isArray(c.closedDays) ? c.closedDays : [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function save() {
    setSaving(true); setFlash('')
    try {
      await fetch('/api/restaurant/disco-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          onlineOrderingEnabled: onlineOrdering,
          notificationEmails, textNotificationsEnabled: textNotifications, notificationSmsNumbers: notificationSms,
          orderReminderEmailsEnabled: orderReminders, adminOrderReminderEmailsEnabled: adminReminders,
          enableMenuSearch, deliveryOrderTimeWindows: deliveryWindow, announcement,
        }),
      })
      setFlash('Saved'); setTimeout(() => setFlash(''), 2500)
    } finally { setSaving(false) }
  }

  async function addClosedDay() {
    if (!cdFrom) return
    await fetch('/api/restaurant/disco-closed-days', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cdName, fromDate: cdFrom, toDate: cdTo || cdFrom }) })
    setCdName(''); setCdFrom(''); setCdTo(''); await load()
  }
  async function removeClosedDay(ref: string) { await fetch(`/api/restaurant/disco-closed-days/${ref}`, { method: 'DELETE' }); await load() }

  const card: React.CSSProperties = { background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '22px 26px', marginBottom: 18 }
  const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }
  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F, border: '1px solid #ddd', borderRadius: 8, boxSizing: 'border-box' }
  const h2: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 14 }
  const toggle = (checked: boolean, onChange: (v: boolean) => void, text: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: DARK, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: BLUE }} /> {text}
    </label>
  )
  const publicUrl = slug ? `https://www.discocater.com/restaurants/${slug}` : ''

  if (loading) return <div style={{ padding: 40, color: '#aaa', fontFamily: F }}>Loading…</div>

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>General Settings</h1>
        <button onClick={save} disabled={saving} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}{flash && <span style={{ marginLeft: 8 }}>✓</span>}</button>
      </div>

      {/* 1 — Online Ordering */}
      <div style={card}>
        <div style={h2}>Online Ordering</div>
        {toggle(onlineOrdering, setOnlineOrdering, 'Accept online orders')}
      </div>

      {/* 2 — Disco Cater URL */}
      <div style={card}>
        <div style={h2}>Disco Cater URL</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>The link customers use to find your menu on Disco Cater.</div>
        {publicUrl ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input readOnly value={publicUrl} style={{ ...input, minWidth: 320, color: '#555', background: '#fafafa' }} />
            <button onClick={() => { navigator.clipboard?.writeText(publicUrl); setFlash('URL copied'); setTimeout(() => setFlash(''), 2000) }} title="Copy URL" style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', fontSize: 13, color: '#555', fontFamily: F }}>⧉</button>
            <a href={publicUrl} target="_blank" rel="noreferrer" title="Open in new tab" style={{ color: BLUE, fontSize: 16, lineHeight: 1, padding: '8px 10px', textDecoration: 'none', border: '1px solid #e8e8e8', borderRadius: 8 }}>↗</a>
          </div>
        ) : <div style={{ fontSize: 13, color: '#aaa' }}>No public URL set yet.</div>}
      </div>

      {/* 3 — Email Notification Recipients */}
      <div style={card}>
        <div style={h2}>Email Notification Recipients</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>Where order emails are sent (comma-separated).</div>
        <input value={notificationEmails} onChange={e => setNotificationEmails(e.target.value)} placeholder="orders@restaurant.com, owner@restaurant.com" style={input} />
      </div>

      {/* 4 — Text Notifications */}
      <div style={card}>
        <div style={h2}>Text Notifications</div>
        {toggle(textNotifications, setTextNotifications, 'Send order notifications by text message')}
      </div>

      {/* 5 — Text Notification Recipients */}
      <div style={card}>
        <div style={h2}>Text Notification Recipients</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>Phone numbers for text notifications (comma-separated).</div>
        <input value={notificationSms} onChange={e => setNotificationSms(e.target.value)} placeholder="+16155551234, +16155555678" style={input} />
      </div>

      {/* 6 — Customer Order Reminder Emails */}
      <div style={card}>
        <div style={h2}>Customer Order Reminder Emails</div>
        {toggle(orderReminders, setOrderReminders, 'Email the customer a reminder ~24h before their order')}
      </div>

      {/* 7 — Restaurant Order Reminder Emails */}
      <div style={card}>
        <div style={h2}>Restaurant Order Reminder Emails</div>
        {toggle(adminReminders, setAdminReminders, 'Email your team a reminder ~24h before an order (to the recipients above)')}
      </div>

      {/* 8 — Enable Menu Search */}
      <div style={card}>
        <div style={h2}>Enable Menu Search</div>
        {toggle(enableMenuSearch, setEnableMenuSearch, 'Show a search box on your menu page')}
      </div>

      {/* 9 — Delivery Order Time Windows */}
      <div style={card}>
        <div style={h2}>Delivery Order Time Windows</div>
        <label style={label}>Delivery time shown to customers as</label>
        <select value={deliveryWindow} onChange={e => setDeliveryWindow(e.target.value as 'exact' | '30_min' | '1_hour')} style={{ ...input, maxWidth: 220 }}>
          <option value="exact">Exact time</option><option value="30_min">30-minute window</option><option value="1_hour">1-hour window</option>
        </select>
      </div>

      {/* 10 — Announcement Banner */}
      <div style={card}>
        <div style={h2}>Announcement Banner</div>
        <textarea value={announcement} onChange={e => setAnnouncement(e.target.value)} maxLength={500} rows={3} placeholder="Show a message to customers on your menu page…" style={{ ...input, width: '100%', resize: 'vertical' }} />
        <div style={{ fontSize: 11, color: '#bbb', marginTop: 6 }}>{announcement.length}/500</div>
      </div>

      {/* 11 — Schedule Override (Closed Days) */}
      <div style={card}>
        <div style={h2}>Schedule Override</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 14 }}>Restaurant-wide closures (holidays). Applies across all menus.</div>
        {closedDays.map(d => (
          <div key={d.reference} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid #f4f4f8', fontSize: 13 }}>
            <span>{d.name || 'Closed'} · {d.from_date}{d.to_date !== d.from_date ? ` – ${d.to_date}` : ''}</span>
            <button onClick={() => removeClosedDay(d.reference)} style={{ background: 'none', border: 'none', color: RED, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Remove</button>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 1.4fr auto', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <input value={cdName} onChange={e => setCdName(e.target.value)} placeholder="Name (e.g. Christmas)" style={input} />
          <input type="date" value={cdFrom} onChange={e => setCdFrom(e.target.value)} style={input} />
          <input type="date" value={cdTo} onChange={e => setCdTo(e.target.value)} style={input} />
          <button onClick={addClosedDay} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Add</button>
        </div>
      </div>
    </div>
  )
}
