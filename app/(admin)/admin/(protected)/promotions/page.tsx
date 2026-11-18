'use client'
// Super Admin → Promotions: give a diner "Free delivery on your next order from [restaurant]", and
// see / cancel every promotion (lib/promotions/diner-promotions.ts). Disco funds these: the
// restaurant's payout is unchanged and Disco still pays the courier.
import { useState, useEffect, useCallback, useRef } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GOLD = '#EFB84A'
const PAGE_BG = '#F7F8FC'

type Status = 'OFFERED' | 'ACTIVATED' | 'USED' | 'EXPIRED' | 'CANCELLED'
const STATUSES: Status[] = ['OFFERED', 'ACTIVATED', 'USED', 'EXPIRED', 'CANCELLED']
const STATUS_LABEL: Record<Status, string> = { OFFERED: 'Offered', ACTIVATED: 'Activated', USED: 'Used', EXPIRED: 'Expired', CANCELLED: 'Cancelled' }
const STATUS_STYLE: Record<Status, { bg: string; fg: string }> = {
  OFFERED: { bg: '#EEF0FF', fg: '#3D4BB8' },
  ACTIVATED: { bg: '#E1F5EE', fg: '#085041' },
  USED: { bg: '#F1F1F4', fg: '#444' },
  EXPIRED: { bg: '#FFF4E5', fg: '#9A5B00' },
  CANCELLED: { bg: '#FFF0F0', fg: '#C62828' },
}

interface Promotion {
  reference: string; status: Status; customerEmail: string; customerName: string
  restaurantName: string; expiresOn: string; note: string | null; createdBy: string | null; createdAt: string
  emailedAt: string | null; activatedAt: string | null; orderNumber: number | null; waivedAmount: number | null
}
interface DinerHit { id: number; email: string; name: string }
interface RestaurantHit { reference: string; name: string; city: string | null; state: string | null }

function ymdToday(): string { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) }
function plusDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
function fmtYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
function fmtTs(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
}

export default function PromotionsAdminPage() {
  const [rows, setRows] = useState<Promotion[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [fDiner, setFDiner] = useState('')
  const [fRestaurant, setFRestaurant] = useState('')
  const [fStatus, setFStatus] = useState<Status | ''>('')
  const [fCreatedBy, setFCreatedBy] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const q = new URLSearchParams()
    if (fDiner.trim()) q.set('diner', fDiner.trim())
    if (fRestaurant.trim()) q.set('restaurant', fRestaurant.trim())
    if (fStatus) q.set('status', fStatus)
    if (fCreatedBy.trim()) q.set('createdBy', fCreatedBy.trim())
    try {
      const res = await fetch(`/api/admin/promotions?${q}`)
      if (res.ok) { const d = await res.json(); setRows(d.promotions || []) }
    } catch { /* ignore */ }
    setLoading(false)
  }, [fDiner, fRestaurant, fStatus, fCreatedBy])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  async function cancel(p: Promotion) {
    if (!confirm(`Cancel free delivery from ${p.restaurantName} for ${p.customerEmail}? The diner will no longer be able to use it.`)) return
    setBusy(p.reference)
    try {
      const res = await fetch(`/api/admin/promotions/${p.reference}/cancel`, { method: 'POST' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Could not cancel.') }
      await load()
    } catch { alert('Network error.') }
    setBusy(null)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 4px' }}>Promotions</h1>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 22px' }}>
        Offers to one diner, funded by Disco. Free delivery waives the diner&apos;s delivery fee on their next third-party delivery order from that restaurant; the restaurant&apos;s payout is unchanged and Disco still pays the courier.
      </p>

      <AddForm onCreated={load} />

      <h2 style={{ fontSize: 13, fontWeight: 700, color: '#666', margin: '28px 0 12px', textTransform: 'uppercase', letterSpacing: 0.5 }}>All Promotions</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, marginBottom: 12 }}>
        <input value={fDiner} onChange={e => setFDiner(e.target.value)} placeholder="Diner (name or email)" aria-label="Filter by diner" style={inputSt} />
        <input value={fRestaurant} onChange={e => setFRestaurant(e.target.value)} placeholder="Restaurant" aria-label="Filter by restaurant" style={inputSt} />
        <select value={fStatus} onChange={e => setFStatus(e.target.value as Status | '')} aria-label="Filter by status" style={inputSt}>
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <input value={fCreatedBy} onChange={e => setFCreatedBy(e.target.value)} placeholder="Created by" aria-label="Filter by creator" style={inputSt} />
      </div>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>
              {['Diner', 'Restaurant', 'Status', 'Expires', 'Created', 'Order', 'Waived', ''].map((h, i) => (
                <th key={i} style={{ ...colHead, textAlign: i >= 6 ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={8} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={8} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>No promotions match.</td></tr>}
            {rows.map(p => {
              const st = STATUS_STYLE[p.status]
              const cancellable = p.status === 'OFFERED' || p.status === 'ACTIVATED'
              return (
                <tr key={p.reference}>
                  <td style={cell}>
                    <div style={{ fontWeight: 700 }}>{p.customerName || p.customerEmail}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{p.customerEmail}</div>
                  </td>
                  <td style={cell}>
                    <div>{p.restaurantName}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>Free delivery{p.note ? ` · ${p.note}` : ''}</div>
                  </td>
                  <td style={cell}><span style={{ background: st.bg, color: st.fg, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{STATUS_LABEL[p.status]}</span></td>
                  <td style={{ ...cell, color: '#666', whiteSpace: 'nowrap' }}>{fmtYmd(p.expiresOn)}</td>
                  <td style={{ ...cell, color: '#666' }}>
                    <div style={{ whiteSpace: 'nowrap' }}>{fmtTs(p.createdAt)}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{p.createdBy || '—'}{p.emailedAt ? ' · emailed' : ''}</div>
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>{p.orderNumber ? `#${p.orderNumber}` : '—'}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{p.waivedAmount != null ? `$${p.waivedAmount.toFixed(2)}` : '—'}</td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {cancellable && <button onClick={() => cancel(p)} disabled={busy === p.reference} style={{ ...linkBtn, color: '#E24B4A' }}>Cancel</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Add form ──────────────────────────────────────────────────────────────────

function AddForm({ onCreated }: { onCreated: () => void }) {
  const [diner, setDiner] = useState<DinerHit | null>(null)
  const [restaurant, setRestaurant] = useState<RestaurantHit | null>(null)
  const [expiresOn, setExpiresOn] = useState(plusDays(ymdToday(), 60))
  const [note, setNote] = useState('')
  const [emailDiner, setEmailDiner] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  async function submit() {
    setError(''); setOkMsg('')
    if (!diner) { setError('Pick a diner.'); return }
    if (!restaurant) { setError('Pick a restaurant.'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/promotions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: diner.id, restaurantReference: restaurant.reference, expiresOn: expiresOn || null, note: note || null, emailDiner }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not add the promotion.'); setSaving(false); return }
      setOkMsg(`Free delivery from ${restaurant.name} added for ${diner.email}${emailDiner ? (d.emailed ? ', and emailed' : ' (the email could not be sent)') : ''}.`)
      setDiner(null); setRestaurant(null); setExpiresOn(plusDays(ymdToday(), 60)); setNote(''); setEmailDiner(true)
      onCreated()
    } catch { setError('Network error.') }
    setSaving(false)
  }

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '20px 22px' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 16 }}>Add a Promotion</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
        <Field label="Diner">
          <TypeAhead<DinerHit> kind="diner" placeholder="Name or email" selected={diner} onSelect={setDiner}
            label={d => d.email} sub={d => d.name} />
        </Field>
        <Field label="Type">
          <select value="FREE_DELIVERY" disabled style={inputSt}><option value="FREE_DELIVERY">Free delivery</option></select>
        </Field>
        <Field label="Restaurant (third-party delivery only)">
          <TypeAhead<RestaurantHit> kind="restaurant" placeholder="Search restaurants" selected={restaurant} onSelect={setRestaurant}
            label={r => r.name} sub={r => [r.city, r.state].filter(Boolean).join(', ')} />
        </Field>
        <Field label="Expires (optional, default 60 days)">
          <input type="date" value={expiresOn} min={ymdToday()} onChange={e => setExpiresOn(e.target.value)} style={inputSt} />
        </Field>
        <Field label="Internal note (optional)">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Not shown to the diner" style={inputSt} />
        </Field>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: DARK, cursor: 'pointer' }}>
        <input type="checkbox" checked={emailDiner} onChange={e => setEmailDiner(e.target.checked)} style={{ accentColor: BLUE, width: 16, height: 16 }} />
        Email the diner
      </label>
      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginTop: 14, fontSize: 13 }}>{error}</div>}
      {okMsg && <div style={{ background: '#E1F5EE', color: '#085041', padding: 10, borderRadius: 8, marginTop: 14, fontSize: 13, fontWeight: 600 }}>{okMsg}</div>}
      <div style={{ marginTop: 16 }}>
        <button onClick={submit} disabled={saving}
          style={{ background: GOLD, color: DARK, border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: F, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Adding…' : 'Add Promotion'}
        </button>
      </div>
    </div>
  )
}

// Search as you type against /api/admin/promotions/lookup.
function TypeAhead<T>({ kind, placeholder, selected, onSelect, label, sub }: {
  kind: 'diner' | 'restaurant'; placeholder: string; selected: T | null; onSelect: (v: T | null) => void
  label: (v: T) => string; sub: (v: T) => string
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<T[]>([])
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (selected) return
    if (timer.current) clearTimeout(timer.current)
    if (q.trim().length < 2) return
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/promotions/lookup?kind=${kind}&q=${encodeURIComponent(q.trim())}`)
        if (res.ok) { const d = await res.json(); setHits(d.results || []); setOpen(true) }
      } catch { /* ignore */ }
    }, 250)
  }, [q, selected, kind])

  if (selected) {
    return (
      <div style={{ ...inputSt, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong>{label(selected)}</strong>{sub(selected) ? <span style={{ color: '#888' }}> · {sub(selected)}</span> : null}</span>
        <button onClick={() => { onSelect(null); setQ('') }} style={{ ...linkBtn, marginLeft: 0 }} aria-label="Clear">✕</button>
      </div>
    )
  }
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => hits.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder={placeholder} style={inputSt} />
      {open && q.trim().length >= 2 && hits.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, marginTop: 4, boxShadow: '0 6px 20px rgba(0,0,0,0.08)', zIndex: 10, maxHeight: 260, overflowY: 'auto' }}>
          {hits.map((h, i) => (
            <button key={i} onMouseDown={() => { onSelect(h); setOpen(false) }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: '#fff', cursor: 'pointer', fontFamily: F, fontSize: 13, color: DARK }}>
              <div style={{ fontWeight: 600 }}>{label(h)}</div>
              {sub(h) && <div style={{ fontSize: 12, color: '#888' }}>{sub(h)}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</label>
      {children}
    </div>
  )
}

const inputSt: React.CSSProperties = { width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', boxSizing: 'border-box' }
const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'top' }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4 }
