'use client'
import { useEffect, useState } from 'react'
import { HOLIDAYS } from '../../../../../../lib/holidays'

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
  const [urlSlug, setUrlSlug] = useState('')     // editable Disco Cater URL slug
  const [urlError, setUrlError] = useState('')
  const [onlineOrdering, setOnlineOrdering] = useState(true)
  const [stripeConnected, setStripeConnected] = useState(false)   // RM2 gate
  const [marketplaceVisible, setMarketplaceVisible] = useState(false) // RM3
  const [notificationEmails, setNotificationEmails] = useState('')
  const [textNotifications, setTextNotifications] = useState(false)
  const [notificationSms, setNotificationSms] = useState('')
  const [orderReminders, setOrderReminders] = useState(false)       // customer
  const [adminReminders, setAdminReminders] = useState(false)       // restaurant
  const [enableMenuSearch, setEnableMenuSearch] = useState(false)
  const [deliveryWindow, setDeliveryWindow] = useState<'exact' | '30_min' | '1_hour'>('exact')
  const [announcement, setAnnouncement] = useState('')

  const [closedDays, setClosedDays] = useState<ClosedDay[]>([])
  const [holidays, setHolidays] = useState<Set<string>>(new Set())
  // Baseline of holidays as last loaded/saved — holiday checkboxes are edited
  // purely in-memory (no fetch) and only persisted on Save, by diffing against
  // this. Prevents a checkbox click from reloading the page and wiping other
  // unsaved edits.
  const [initialHolidays, setInitialHolidays] = useState<Set<string>>(new Set())
  const [cdName, setCdName] = useState(''); const [cdFrom, setCdFrom] = useState(''); const [cdTo, setCdTo] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [s, c, st, mv] = await Promise.all([
        fetch('/api/restaurant/disco-settings').then(r => r.json()),
        fetch('/api/restaurant/disco-closed-days').then(r => r.json()),
        fetch('/api/restaurant/stripe-status').then(r => r.ok ? r.json() : { connected: false }).catch(() => ({ connected: false })),
        fetch('/api/restaurant/marketplace-visibility').then(r => r.ok ? r.json() : { visible: false }).catch(() => ({ visible: false })),
      ])
      const set = s.settings || {}
      setSlug(s.slug || null); setUrlSlug(s.slug || ''); setUrlError('')
      setStripeConnected(!!st.connected)
      setMarketplaceVisible(!!mv.visible)
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
      const hol = new Set<string>(Array.isArray(c.holidays) ? c.holidays : [])
      setHolidays(hol)
      setInitialHolidays(new Set(hol))
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // Reload ONLY the closed-days list (custom dates) without touching holidays or
  // any settings state — used after Add/Remove of a custom closed date so those
  // discrete actions don't wipe unsaved edits elsewhere on the page.
  async function loadClosedDays() {
    const c = await fetch('/api/restaurant/disco-closed-days').then(r => r.json())
    setClosedDays(Array.isArray(c.closedDays) ? c.closedDays : [])
  }

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
      // Persist holiday checkbox changes (edited in-memory since load) by diffing
      // against the baseline. The server pre-computes/clears 50 years of dates.
      const toEnable = [...holidays].filter(h => !initialHolidays.has(h))
      const toDisable = [...initialHolidays].filter(h => !holidays.has(h))
      for (const name of [...toEnable, ...toDisable]) {
        await fetch('/api/restaurant/disco-closed-days', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ holiday: name, enabled: holidays.has(name) }),
        })
      }
      setInitialHolidays(new Set(holidays))
      setFlash('Saved'); setTimeout(() => setFlash(''), 2500)
    } finally { setSaving(false) }
  }

  // Same slug rule as the disco-url route (validate early in the UI).
  function slugError(s: string): string | null {
    if (!s) return null
    if (s.length < 3) return 'URL must be at least 3 characters.'
    if (s.length > 60) return 'URL must be at most 60 characters.'
    if (!/^[a-z0-9-]+$/.test(s)) return 'URL can only contain lowercase letters, numbers, and hyphens.'
    if (s.startsWith('-') || s.endsWith('-')) return 'URL cannot start or end with a hyphen.'
    return null
  }
  async function saveUrl() {
    const err = slugError(urlSlug)
    if (err || !urlSlug) { setUrlError(err || 'Enter a URL.'); return }
    const res = await fetch('/api/restaurant/disco-url', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: urlSlug }) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setUrlError(d.error || 'Could not save URL.'); return }
    setSlug(urlSlug); setUrlError(''); setFlash('URL updated'); setTimeout(() => setFlash(''), 2000)
  }

  async function addClosedDay() {
    if (!cdFrom) return
    await fetch('/api/restaurant/disco-closed-days', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cdName, fromDate: cdFrom, toDate: cdTo || cdFrom }) })
    setCdName(''); setCdFrom(''); setCdTo(''); await loadClosedDays()
  }
  async function removeClosedDay(ref: string) { await fetch(`/api/restaurant/disco-closed-days/${ref}`, { method: 'DELETE' }); await loadClosedDays() }
  function toggleHoliday(name: string, on: boolean) {
    // Local/in-memory only — no fetch, no reload. Persisted on Save (see save()),
    // so toggling a holiday can't wipe other unsaved changes on the page.
    setHolidays(prev => { const n = new Set(prev); on ? n.add(name) : n.delete(name); return n })
  }

  // RM3: marketplace visibility is an immediate action (not part of the batch
  // Save), matching the FM settings page. Optimistic with revert on failure.
  async function toggleMarketplace(v: boolean) {
    setMarketplaceVisible(v)
    try {
      const res = await fetch('/api/restaurant/marketplace-visibility', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: v }),
      })
      if (!res.ok) setMarketplaceVisible(!v)
    } catch { setMarketplaceVisible(!v) }
  }

  const card: React.CSSProperties = { background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '22px 26px', marginBottom: 18 }
  const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }
  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F, border: '1px solid #ddd', borderRadius: 8, boxSizing: 'border-box' }
  const h2: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 14 }
  const toggle = (checked: boolean, onChange: (v: boolean) => void, text: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: DARK, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: BLUE }} /> {text}
    </label>
  )
  // The Disco Cater URL is the restaurant's direct 1P (first-party) ordering
  // link — /order/{slug} — NOT the /restaurants/{slug} marketplace listing.
  const publicUrl = slug ? `https://www.discocater.com/order/${slug}` : ''

  if (loading) return <div style={{ padding: 40, color: '#aaa', fontFamily: F }}>Loading…</div>

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 680 }}>
      {/* Sticky header keeps Save reachable no matter how far the page scrolls. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: '#F7F8FC', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0 14px', marginBottom: 8, borderBottom: '1px solid #ececf2' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>General Settings</h1>
        <button onClick={save} disabled={saving} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: saving ? 0.6 : 1, boxShadow: '0 2px 8px rgba(107,110,249,0.25)' }}>{saving ? 'Saving…' : 'Save'}{flash && <span style={{ marginLeft: 8 }}>✓ {flash}</span>}</button>
      </div>

      {/* 1 — Online Ordering (RM2: requires a connected Stripe account) */}
      <div style={card}>
        <div style={h2}>Online Ordering</div>
        {toggle(onlineOrdering, (v) => { if (v && !stripeConnected) return; setOnlineOrdering(v) }, 'Accept online orders')}
        {!stripeConnected && (
          <p style={{ fontSize: 12, color: '#E76F51', margin: '8px 0 0' }}>
            Connect a Stripe account in Banking to enable online ordering.
          </p>
        )}
      </div>

      {/* Disco Cater Marketplace visibility (RM3) — immediate toggle. */}
      <div style={card}>
        <div style={h2}>Disco Cater Marketplace</div>
        {toggle(marketplaceVisible, toggleMarketplace, 'List my restaurant on the Disco Cater marketplace')}
        <p style={{ fontSize: 12, color: '#999', margin: '8px 0 0' }}>
          You appear on the marketplace only when this is on, online ordering is enabled, and your Stripe account is connected.
        </p>
      </div>

      {/* 2 — Disco Cater URL */}
      <div style={card}>
        <div style={h2}>Disco Cater URL</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>The link customers use to find your menu on Disco Cater. Lowercase letters, numbers, and hyphens; 3–60 characters; unique across all restaurants.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#888', whiteSpace: 'nowrap' }}>https://www.discocater.com/order/</span>
          <input
            value={urlSlug}
            onChange={e => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); setUrlSlug(v); setUrlError(slugError(v) || '') }}
            placeholder="my-restaurant"
            style={{ ...input, minWidth: 200, maxWidth: 240, borderColor: urlError ? RED : '#ddd' }}
          />
          {urlSlug !== (slug || '') ? (
            <button onClick={saveUrl} disabled={!!urlError} style={{ padding: '9px 16px', background: urlError ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: urlError ? 'not-allowed' : 'pointer', fontFamily: F }}>Save</button>
          ) : slug ? (
            <>
              <button onClick={() => { navigator.clipboard?.writeText(publicUrl); setFlash('URL copied'); setTimeout(() => setFlash(''), 2000) }} title="Copy URL" style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', fontSize: 13, color: '#555', fontFamily: F }}>⧉</button>
              <a href={publicUrl} target="_blank" rel="noreferrer" title="Open in new tab" style={{ color: BLUE, fontSize: 16, lineHeight: 1, padding: '8px 10px', textDecoration: 'none', border: '1px solid #e8e8e8', borderRadius: 8 }}>↗</a>
            </>
          ) : null}
        </div>
        {urlError && <p style={{ fontSize: 12, color: RED, margin: '6px 0 0' }}>{urlError}</p>}
      </div>

      {/* 3 — Email Notification Recipients */}
      <div style={card}>
        <div style={h2}>Email Notification Recipients</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>Where order emails are sent. Type an address and press Enter (or Add).</div>
        <TagInput value={notificationEmails} onChange={setNotificationEmails} placeholder="orders@restaurant.com" />
      </div>

      {/* 4 — Text Notifications */}
      <div style={card}>
        <div style={h2}>Text Notifications</div>
        {toggle(textNotifications, setTextNotifications, 'Send order notifications by text message')}
      </div>

      {/* 5 — Text Notification Recipients */}
      <div style={card}>
        <div style={h2}>Text Notification Recipients</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>Phone numbers for text notifications. Type a number and press Enter (or Add).</div>
        <TagInput value={notificationSms} onChange={setNotificationSms} placeholder="+16155551234" />
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
        <div style={{ fontSize: 12, color: '#999', marginBottom: 14 }}>Restaurant-wide closures. Applies across all menus and blocks customers from ordering on those dates.</div>

        {/* Closed Holidays — toggling one blocks that holiday's date every year (pre-computed for 50 years). */}
        <div style={{ fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 8 }}>Closed Holidays</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 24, rowGap: 2, marginBottom: 18 }}>
          {HOLIDAYS.map(name => (
            <label key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', fontSize: 13, color: DARK, cursor: 'pointer' }}>
              <span>{name}</span>
              <input type="checkbox" checked={holidays.has(name)} onChange={e => toggleHoliday(name, e.target.checked)} style={{ accentColor: BLUE, cursor: 'pointer' }} />
            </label>
          ))}
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 8, borderTop: '1px solid #f0f0f0', paddingTop: 14 }}>Custom Closed Dates</div>
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

// #18: tag/chip input for multi-value recipient fields. Reads and emits a
// comma-separated string (so the surrounding save logic is unchanged) but presents
// each value as a removable chip. Add via Enter, comma, or the Add button; remove
// via the chip's × or Backspace on an empty input.
function TagInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('')
  const tags = value.split(',').map(s => s.trim()).filter(Boolean)
  const commit = (raw: string) => {
    const parts = raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) { setDraft(''); return }
    const next = [...tags]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next.join(', '))
    setDraft('')
  }
  const remove = (t: string) => onChange(tags.filter(x => x !== t).join(', '))
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', border: '1px solid #ddd', borderRadius: 8, padding: '7px 9px', minHeight: 42, background: '#fff' }}>
        {tags.map(t => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#EEF0FD', color: '#4046B8', borderRadius: 16, padding: '4px 6px 4px 11px', fontSize: 12.5, fontWeight: 600 }}>
            {t}
            <button type="button" onClick={() => remove(t)} aria-label={`Remove ${t}`} style={{ border: 'none', background: 'rgba(64,70,184,0.15)', color: '#4046B8', borderRadius: '50%', width: 16, height: 16, cursor: 'pointer', fontSize: 11, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </span>
        ))}
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(draft) }
            else if (e.key === 'Backspace' && !draft && tags.length) { remove(tags[tags.length - 1]) }
          }}
          onBlur={() => { if (draft.trim()) commit(draft) }}
          placeholder={tags.length ? '' : placeholder}
          style={{ flex: '1 1 140px', minWidth: 120, border: 'none', outline: 'none', fontSize: 13, fontFamily: F, padding: '4px 2px', background: 'transparent' }}
        />
      </div>
      <button type="button" onClick={() => commit(draft)} disabled={!draft.trim()}
        style={{ marginTop: 8, background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, color: draft.trim() ? '#4046B8' : '#bbb', cursor: draft.trim() ? 'pointer' : 'default', fontFamily: F }}>
        + Add
      </button>
    </div>
  )
}
