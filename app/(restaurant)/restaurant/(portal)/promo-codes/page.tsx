'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast, confirmDialog } from '../../../../components/ui/feedback'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const PAGE_BG = '#F7F8FC'

// FM coupon shape (mirrors the Settings Coupon interface).
interface PromoCode {
  reference?: string
  code: string
  discountPercentage: number
  startDate: string
  endDate: string
  maxAvailable: number
  maxPerDiner: number
  remainingAvailable?: number
}

// FM dates come back as DD.MM.YYYY (what we send); tolerate ISO too. Render a
// friendly label, falling back to the raw value if it's an unknown shape.
function fmtDate(s: string): string {
  if (!s) return '—'
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  let d: Date | null = null
  if (dmy) d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]))
  else if (iso) d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  if (d && !isNaN(d.getTime())) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return s
}

export default function PromoCodesPage() {
  const [codes, setCodes] = useState<PromoCode[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/restaurant/promo-codes')
      if (res.ok) { const d = await res.json(); setCodes(Array.isArray(d.codes) ? d.codes : []) }
      else setCodes([])
    } catch { setCodes([]) }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  async function remove(c: PromoCode) {
    const ok = await confirmDialog(`Delete promo code “${c.code}”? This cannot be undone.`, { title: 'Delete promo code', confirmText: 'Delete', danger: true })
    if (!ok) return
    setBusy(c.code)
    try {
      const res = await fetch('/api/restaurant/promo-codes', { method: 'DELETE' })
      if (res.ok) { toast('Promo code deleted', { kind: 'success' }); load() }
      else { const d = await res.json().catch(() => ({})); toast(d.error || 'Could not delete promo code.', { kind: 'error' }) }
    } catch { toast('Network error.', { kind: 'error' }) }
    setBusy(null)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 22 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 4px' }}>Promo Codes</h1>
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Create and manage discount codes customers can apply at checkout.</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          style={{ flexShrink: 0, background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
          + Create Promo Code
        </button>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Code', 'Discount', 'Start Date', 'End Date', 'Max Uses', 'Per Diner', ''].map((h, i) => (
                <th key={i} style={{ ...colHead, textAlign: i === 6 ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>Loading…</td></tr>}
            {!loading && codes.length === 0 && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>No promo codes yet.</td></tr>}
            {!loading && codes.map((c, i) => (
              <tr key={c.reference || c.code || i}>
                <td style={{ ...cell, fontWeight: 700 }}>{c.code}</td>
                <td style={cell}>{c.discountPercentage}%</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(c.startDate)}</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(c.endDate)}</td>
                <td style={cell}>
                  {c.maxAvailable ?? '—'}
                  {c.remainingAvailable != null && <span style={{ color: '#aaa' }}> ({c.remainingAvailable} left)</span>}
                </td>
                <td style={cell}>{c.maxPerDiner ?? 1}</td>
                <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => remove(c)} disabled={busy === c.code}
                    style={{ background: 'none', border: 'none', color: '#E53935', cursor: busy === c.code ? 'default' : 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', fontWeight: 600 }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load() }} />}
    </div>
  )
}

// ── Create modal ────────────────────────────────────────────────────────────
function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState('')
  const [discount, setDiscount] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [maxAvailable, setMaxAvailable] = useState('')
  const [maxPerDiner, setMaxPerDiner] = useState('1')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    const cleanCode = code.trim().toUpperCase()
    if (!cleanCode || !/^[A-Z0-9]+$/.test(cleanCode)) { setError('Code is required and must be uppercase letters/numbers only.'); return }
    const pct = parseFloat(discount)
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) { setError('Discount must be a number between 1 and 100.'); return }
    if (!startDate || !endDate) { setError('Start and end dates are required.'); return }
    if (endDate < startDate) { setError('End date must be on or after the start date.'); return }
    const maxAvail = parseInt(maxAvailable, 10)
    if (!Number.isInteger(maxAvail) || maxAvail < 1) { setError('Max available must be a whole number of 1 or more.'); return }
    const perDiner = maxPerDiner.trim() ? parseInt(maxPerDiner, 10) : 1
    if (!Number.isInteger(perDiner) || perDiner < 1) { setError('Max per diner must be a whole number of 1 or more.'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/restaurant/promo-codes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cleanCode,
          discountPercentage: pct,
          startDate, // YYYY-MM-DD — the API converts to DD.MM.YYYY for FM
          endDate,
          maxAvailable: maxAvail,
          maxPerDiner: perDiner,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not create promo code.'); setSaving(false); return }
      toast(`Created ${cleanCode}`, { kind: 'success' })
      onCreated()
    } catch { setError('Network error. Please try again.'); setSaving(false) }
  }

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: F }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 16, padding: '26px 28px', maxWidth: 460, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: DARK, margin: '0 0 18px' }}>Create Promo Code</h2>

        <Field label="Code">
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="SUMMER25" style={inputSt} />
        </Field>
        <Field label="Discount %">
          <input type="number" min="1" max="100" step="1" value={discount} onChange={e => setDiscount(e.target.value)} placeholder="10" style={inputSt} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Start Date">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputSt} />
          </Field>
          <Field label="End Date">
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputSt} />
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Max Available">
            <input type="number" min="1" step="1" value={maxAvailable} onChange={e => setMaxAvailable(e.target.value)} placeholder="100" style={inputSt} />
          </Field>
          <Field label="Max Per Diner">
            <input type="number" min="1" step="1" value={maxPerDiner} onChange={e => setMaxPerDiner(e.target.value)} placeholder="1" style={inputSt} />
          </Field>
        </div>

        {error && <div style={{ background: '#fff3f3', color: '#c0392b', padding: '10px 12px', borderRadius: 8, marginTop: 6, fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} disabled={saving}
            style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', color: '#444', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
            Cancel
          </button>
          <button onClick={submit} disabled={saving}
            style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: F, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Creating…' : 'Create Promo Code'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</label>
      {children}
    </div>
  )
}

const inputSt: React.CSSProperties = { width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', boxSizing: 'border-box' }
const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
