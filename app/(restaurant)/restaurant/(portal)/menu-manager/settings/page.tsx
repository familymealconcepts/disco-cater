'use client'
import { useEffect, useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface TaxLeg { percent: string; fixedAmount: string }
interface ClosedDay { reference: string; name: string | null; from_date: string; to_date: string }

const emptyTax = (): TaxLeg => ({ percent: '0', fixedAmount: '0' })

export default function RestaurantSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState('')

  const [onlineOrdering, setOnlineOrdering] = useState(true)
  const [deliveryWindow, setDeliveryWindow] = useState<'exact' | '30_min' | '1_hour'>('exact')
  const [stateTax, setStateTax] = useState<TaxLeg>(emptyTax())
  const [localTax, setLocalTax] = useState<TaxLeg>(emptyTax())
  const [otherTax, setOtherTax] = useState<TaxLeg>(emptyTax())
  const [notificationEmails, setNotificationEmails] = useState('')
  const [notificationSms, setNotificationSms] = useState('')
  const [orderReminders, setOrderReminders] = useState(false)

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
      setOnlineOrdering(set.online_ordering_enabled !== false)
      setDeliveryWindow(set.delivery_order_time_windows || 'exact')
      const t = set.tax_rates || {}
      const leg = (x: { percent?: number; fixedAmount?: number } | undefined): TaxLeg => ({ percent: String(x?.percent ?? 0), fixedAmount: String(x?.fixedAmount ?? 0) })
      setStateTax(leg(t.stateSalesTax)); setLocalTax(leg(t.localSalesTax)); setOtherTax(leg(t.otherSalesTax))
      setNotificationEmails(set.notification_emails || ''); setNotificationSms(set.notification_sms_numbers || '')
      setOrderReminders(set.order_reminder_emails_enabled === true)
      setClosedDays(Array.isArray(c.closedDays) ? c.closedDays : [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function save() {
    setSaving(true); setFlash('')
    const num = (v: string) => Number(v) || 0
    try {
      await fetch('/api/restaurant/disco-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          onlineOrderingEnabled: onlineOrdering, deliveryOrderTimeWindows: deliveryWindow,
          taxRates: {
            stateSalesTax: { percent: num(stateTax.percent), fixedAmount: num(stateTax.fixedAmount) },
            localSalesTax: { percent: num(localTax.percent), fixedAmount: num(localTax.fixedAmount) },
            otherSalesTax: { percent: num(otherTax.percent), fixedAmount: num(otherTax.fixedAmount), types: [] },
          },
          notificationEmails, notificationSmsNumbers: notificationSms, orderReminderEmailsEnabled: orderReminders,
        }),
      })
      setFlash('Saved')
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
  const taxRow = (name: string, val: TaxLeg, set: (v: TaxLeg) => void) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, alignItems: 'center', marginBottom: 10 }}>
      <span style={{ fontSize: 13, color: DARK }}>{name}</span>
      <div><input value={val.percent} onChange={e => set({ ...val, percent: e.target.value })} inputMode="decimal" placeholder="%" style={input} /></div>
      <div><input value={val.fixedAmount} onChange={e => set({ ...val, fixedAmount: e.target.value })} inputMode="decimal" placeholder="$ fixed" style={input} /></div>
    </div>
  )

  if (loading) return <div style={{ padding: 40, color: '#aaa', fontFamily: F }}>Loading…</div>

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Restaurant Settings</h1>
        <button onClick={save} disabled={saving} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}{flash && <span style={{ marginLeft: 8 }}>✓</span>}</button>
      </div>

      <div style={card}>
        <div style={h2}>Ordering</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: DARK, cursor: 'pointer', marginBottom: 16 }}>
          <input type="checkbox" checked={onlineOrdering} onChange={e => setOnlineOrdering(e.target.checked)} style={{ accentColor: BLUE }} /> Accept online orders
        </label>
        <label style={label}>Delivery time shown to customers as</label>
        <select value={deliveryWindow} onChange={e => setDeliveryWindow(e.target.value as 'exact' | '30_min' | '1_hour')} style={{ ...input, maxWidth: 220 }}>
          <option value="exact">Exact time</option><option value="30_min">30-minute window</option><option value="1_hour">1-hour window</option>
        </select>
      </div>

      <div style={card}>
        <div style={h2}>Tax rates</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, fontSize: 11, color: '#999', marginBottom: 8 }}><span></span><span>Percent</span><span>Fixed $</span></div>
        {taxRow('State', stateTax, setStateTax)}
        {taxRow('Local', localTax, setLocalTax)}
        {taxRow('Other', otherTax, setOtherTax)}
      </div>

      <div style={card}>
        <div style={h2}>Notifications</div>
        <label style={label}>Order notification emails (comma-separated)</label>
        <input value={notificationEmails} onChange={e => setNotificationEmails(e.target.value)} placeholder="orders@restaurant.com, owner@restaurant.com" style={{ ...input, marginBottom: 14 }} />
        <label style={label}>Order notification SMS numbers (comma-separated)</label>
        <input value={notificationSms} onChange={e => setNotificationSms(e.target.value)} placeholder="+16155551234" style={{ ...input, marginBottom: 14 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: DARK, cursor: 'pointer' }}>
          <input type="checkbox" checked={orderReminders} onChange={e => setOrderReminders(e.target.checked)} style={{ accentColor: BLUE }} /> Send customer order reminder emails
        </label>
      </div>

      <div style={card}>
        <div style={h2}>Closed Days</div>
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
