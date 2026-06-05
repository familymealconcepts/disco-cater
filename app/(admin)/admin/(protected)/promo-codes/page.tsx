'use client'
import { useState, useEffect, useCallback, useRef } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GOLD = '#EFB84A'
const PAGE_BG = '#F7F8FC'

interface PromoCode {
  id: number
  code: string
  discount_type: 'flat' | 'percent'
  discount_value: string | number
  scope: 'global' | 'restaurant'
  restaurant_ref: string | null
  max_uses: number | null
  uses_count: number
  max_uses_per_user: number
  first_time_only: boolean
  min_order_subtotal: string | number | null
  max_discount_cap: string | number | null
  valid_from: string
  valid_until: string | null
  active: boolean
  notes: string | null
}

interface RestaurantHit { reference: string; name: string; location: string }

function todayIso() { return new Date().toISOString().slice(0, 10) }
function num(v: string | number | null | undefined): number | null {
  if (v == null) return null
  const x = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(x) ? x : null
}
function fmtValue(c: PromoCode): string {
  const v = num(c.discount_value) ?? 0
  return c.discount_type === 'percent' ? `${v}%` : `$${v.toFixed(2)}`
}
function fmtDate(s: string | null): string {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return s }
}
function statusOf(c: PromoCode): { label: string; bg: string; fg: string } {
  if (c.valid_until && new Date(c.valid_until).getTime() < Date.now()) return { label: 'Expired', bg: '#FFF0F0', fg: '#C62828' }
  if (!c.active) return { label: 'Inactive', bg: '#F1F1F4', fg: '#666' }
  return { label: 'Active', bg: '#E1F5EE', fg: '#085041' }
}

export default function PromoCodesPage() {
  const [codes, setCodes] = useState<PromoCode[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/promo-codes')
      if (res.ok) { const d = await res.json(); setCodes(d.codes || []) }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  async function toggleActive(c: PromoCode) {
    setBusy(c.id)
    try {
      const res = await fetch(`/api/admin/promo-codes/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }),
      })
      if (res.ok) setCodes(prev => prev.map(x => x.id === c.id ? { ...x, active: !c.active } : x))
      else alert('Could not update the code.')
    } catch { alert('Network error.') }
    setBusy(null)
  }

  async function remove(c: PromoCode) {
    if (c.uses_count > 0) return
    if (!confirm(`Delete promo code “${c.code}”? This cannot be undone.`)) return
    setBusy(c.id)
    try {
      const res = await fetch(`/api/admin/promo-codes/${c.id}`, { method: 'DELETE' })
      if (res.ok) setCodes(prev => prev.filter(x => x.id !== c.id))
      else { const d = await res.json().catch(() => ({})); alert(d.error || 'Could not delete.') }
    } catch { alert('Network error.') }
    setBusy(null)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 4px' }}>Promo Codes</h1>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 22px' }}>
        Disco-side discounts. The restaurant always receives full payment — the discount is refunded to the customer via Stripe after the order is placed.
      </p>

      <CreateForm onCreated={load} />

      {/* Codes table */}
      <h2 style={{ fontSize: 13, fontWeight: 700, color: '#666', margin: '28px 0 12px', textTransform: 'uppercase', letterSpacing: 0.5 }}>All Codes</h2>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Code', 'Type', 'Value', 'Scope', 'Uses', 'Limit', 'Valid Until', 'Status', ''].map((h, i) => (
                <th key={i} style={{ ...colHead, textAlign: i === 8 ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>Loading…</td></tr>}
            {!loading && codes.length === 0 && <tr><td colSpan={9} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>No promo codes yet.</td></tr>}
            {!loading && codes.map(c => {
              const st = statusOf(c)
              return (
                <tr key={c.id}>
                  <td style={{ ...cell, fontWeight: 700 }}>{c.code}</td>
                  <td style={cell}>{c.discount_type === 'percent' ? 'Percent' : 'Flat'}</td>
                  <td style={cell}>{fmtValue(c)}</td>
                  <td style={cell}>{c.scope === 'restaurant' ? 'Restaurant' : 'Global'}</td>
                  <td style={cell}>{c.uses_count}</td>
                  <td style={cell}>{c.max_uses == null ? '∞' : c.max_uses}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(c.valid_until)}</td>
                  <td style={cell}><span style={{ background: st.bg, color: st.fg, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{st.label}</span></td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => toggleActive(c)} disabled={busy === c.id} style={linkBtn}>{c.active ? 'Deactivate' : 'Activate'}</button>
                    <button onClick={() => remove(c)} disabled={busy === c.id || c.uses_count > 0}
                      title={c.uses_count > 0 ? 'Cannot delete a used code' : 'Delete'}
                      style={{ ...linkBtn, color: c.uses_count > 0 ? '#ccc' : '#E24B4A', cursor: c.uses_count > 0 ? 'not-allowed' : 'pointer' }}>Delete</button>
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

// ── Create form ───────────────────────────────────────────────────────────────

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [code, setCode] = useState('')
  const [discountType, setDiscountType] = useState<'flat' | 'percent'>('flat')
  const [discountValue, setDiscountValue] = useState('')
  const [scope, setScope] = useState<'global' | 'restaurant'>('global')
  const [restaurant, setRestaurant] = useState<RestaurantHit | null>(null)
  const [maxDiscountCap, setMaxDiscountCap] = useState('')
  const [minOrderSubtotal, setMinOrderSubtotal] = useState('')
  const [maxUses, setMaxUses] = useState('')
  const [maxUsesPerUser, setMaxUsesPerUser] = useState('1')
  const [firstTimeOnly, setFirstTimeOnly] = useState(false)
  const [validFrom, setValidFrom] = useState(todayIso())
  const [validUntil, setValidUntil] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  async function submit() {
    setError(''); setOkMsg('')
    if (!code.trim()) { setError('Code is required.'); return }
    if (!discountValue || parseFloat(discountValue) <= 0) { setError('Discount value must be greater than 0.'); return }
    if (scope === 'restaurant' && !restaurant) { setError('Pick a restaurant for a restaurant-scoped code.'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/promo-codes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          discountType,
          discountValue: parseFloat(discountValue),
          scope,
          restaurantRef: scope === 'restaurant' ? restaurant?.reference : null,
          maxDiscountCap: discountType === 'percent' ? (maxDiscountCap || null) : null,
          minOrderSubtotal: minOrderSubtotal || null,
          maxUses: maxUses || null,
          maxUsesPerUser: maxUsesPerUser || 1,
          firstTimeOnly,
          validFrom: validFrom || null,
          validUntil: validUntil || null,
          notes: notes || null,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not create code.'); setSaving(false); return }
      setOkMsg(`Created ${code.trim().toUpperCase()}.`)
      // reset
      setCode(''); setDiscountValue(''); setScope('global'); setRestaurant(null)
      setMaxDiscountCap(''); setMinOrderSubtotal(''); setMaxUses(''); setMaxUsesPerUser('1')
      setFirstTimeOnly(false); setValidFrom(todayIso()); setValidUntil(''); setNotes('')
      onCreated()
    } catch { setError('Network error.') }
    setSaving(false)
  }

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '20px 22px' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 16 }}>Create New Code</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
        <Field label="Code">
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="SUMMER50" style={inputSt} />
        </Field>
        <Field label="Discount Type">
          <select value={discountType} onChange={e => setDiscountType(e.target.value as 'flat' | 'percent')} style={inputSt}>
            <option value="flat">Flat $</option>
            <option value="percent">Percentage %</option>
          </select>
        </Field>
        <Field label={discountType === 'percent' ? 'Discount Value (%)' : 'Discount Value ($)'}>
          <input type="number" min="0" step="0.01" value={discountValue} onChange={e => setDiscountValue(e.target.value)} placeholder={discountType === 'percent' ? '10' : '50'} style={inputSt} />
        </Field>
        <Field label="Scope">
          <select value={scope} onChange={e => { setScope(e.target.value as 'global' | 'restaurant'); if (e.target.value === 'global') setRestaurant(null) }} style={inputSt}>
            <option value="global">Global</option>
            <option value="restaurant">Restaurant-specific</option>
          </select>
        </Field>
        {scope === 'restaurant' && (
          <Field label="Restaurant">
            <RestaurantSearch selected={restaurant} onSelect={setRestaurant} />
          </Field>
        )}
        {discountType === 'percent' && (
          <Field label="Max Discount Cap ($, optional)">
            <input type="number" min="0" step="0.01" value={maxDiscountCap} onChange={e => setMaxDiscountCap(e.target.value)} placeholder="No cap" style={inputSt} />
          </Field>
        )}
        <Field label="Min Order Subtotal ($, optional)">
          <input type="number" min="0" step="0.01" value={minOrderSubtotal} onChange={e => setMinOrderSubtotal(e.target.value)} placeholder="None" style={inputSt} />
        </Field>
        <Field label="Max Total Uses (blank = unlimited)">
          <input type="number" min="1" step="1" value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="Unlimited" style={inputSt} />
        </Field>
        <Field label="Max Uses Per User">
          <input type="number" min="1" step="1" value={maxUsesPerUser} onChange={e => setMaxUsesPerUser(e.target.value)} style={inputSt} />
        </Field>
        <Field label="Valid From">
          <input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} style={inputSt} />
        </Field>
        <Field label="Valid Until (optional)">
          <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} style={inputSt} />
        </Field>
        <Field label="Notes (optional)">
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Internal note" style={inputSt} />
        </Field>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: DARK, cursor: 'pointer' }}>
        <input type="checkbox" checked={firstTimeOnly} onChange={e => setFirstTimeOnly(e.target.checked)} style={{ accentColor: BLUE, width: 16, height: 16 }} />
        First-time customers only
      </label>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginTop: 14, fontSize: 13 }}>{error}</div>}
      {okMsg && <div style={{ background: '#E1F5EE', color: '#085041', padding: 10, borderRadius: 8, marginTop: 14, fontSize: 13, fontWeight: 600 }}>{okMsg}</div>}

      <div style={{ marginTop: 16 }}>
        <button onClick={submit} disabled={saving}
          style={{ background: GOLD, color: DARK, border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: F, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Creating…' : 'Create Promo Code'}
        </button>
      </div>
    </div>
  )
}

// Reuses the admin restaurant type-ahead (GET /api/admin/restaurants/search?q=).
function RestaurantSearch({ selected, onSelect }: { selected: RestaurantHit | null; onSelect: (r: RestaurantHit | null) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<RestaurantHit[]>([])
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (selected) return
    if (timer.current) clearTimeout(timer.current)
    if (q.trim().length < 3) { setHits([]); return }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/restaurants/search?q=${encodeURIComponent(q.trim())}`)
        if (res.ok) { setHits(await res.json()); setOpen(true) }
      } catch { /* ignore */ }
    }, 250)
  }, [q, selected])

  if (selected) {
    return (
      <div style={{ ...inputSt, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.name}{selected.location ? ` — ${selected.location}` : ''}</span>
        <button onClick={() => { onSelect(null); setQ('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search restaurants…" style={inputSt} />
      {open && hits.length > 0 && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: '#fff', border: '1px solid #e6e6e6', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', padding: 6, maxHeight: 240, overflow: 'auto', zIndex: 50 }}>
          {hits.map(h => (
            <button key={h.reference} onClick={() => { onSelect(h); setOpen(false) }}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, cursor: 'pointer', borderRadius: 6 }}>
              {h.name}{h.location ? <span style={{ color: '#888' }}> — {h.location}</span> : null}
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
const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4 }
