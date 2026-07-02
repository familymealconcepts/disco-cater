'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast, confirmDialog } from '../../../../components/ui/feedback'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const PAGE_BG = '#F7F8FC'

interface PromoCode {
  id: number
  code: string
  discountPercentage: number
  startDate: string
  endDate: string
  maxAvailable: number | null
  remainingAvailable: number | null
  maxPerDiner: number
  active: boolean
  restaurantRef: string
  restaurantName: string
  moneyFlow: string | null
}
interface Location { reference: string; name: string; moneyFlow: string | null }

function fmtDate(s: string): string {
  if (!s) return '—'
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!iso) return s
  const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function PromoCodesPage() {
  const [codes, setCodes] = useState<PromoCode[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [isSA, setIsSA] = useState(false)
  const [loading, setLoading] = useState(true)
  const [locationFilter, setLocationFilter] = useState('')
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; code: PromoCode } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = locationFilter ? `?restaurantReference=${encodeURIComponent(locationFilter)}` : ''
      const res = await fetch(`/api/restaurant/promo-codes${qs}`)
      if (res.ok) {
        const d = await res.json()
        setCodes(Array.isArray(d.codes) ? d.codes : [])
        setLocations(Array.isArray(d.locations) ? d.locations : [])
        setIsSA(!!d.isSystemAdmin)
      } else { setCodes([]) }
    } catch { setCodes([]) }
    setLoading(false)
  }, [locationFilter])
  useEffect(() => { load() }, [load])

  async function toggleActive(c: PromoCode) {
    setBusy(c.id)
    try {
      const res = await fetch(`/api/restaurant/promo-codes/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }),
      })
      if (res.ok) { toast(c.active ? 'Promo code deactivated' : 'Promo code activated', { kind: 'success' }); load() }
      else { const d = await res.json().catch(() => ({})); toast(d.error || 'Could not update promo code.', { kind: 'error' }) }
    } catch { toast('Network error.', { kind: 'error' }) }
    setBusy(null)
  }

  async function remove(c: PromoCode) {
    const ok = await confirmDialog(`Delete promo code “${c.code}”? This cannot be undone.`, { title: 'Delete promo code', confirmText: 'Delete', danger: true })
    if (!ok) return
    setBusy(c.id)
    try {
      const res = await fetch(`/api/restaurant/promo-codes/${c.id}`, { method: 'DELETE' })
      if (res.ok) { const d = await res.json().catch(() => ({})); toast(d.deactivated ? 'Code had redemptions — deactivated instead' : 'Promo code deleted', { kind: 'success' }); load() }
      else { const d = await res.json().catch(() => ({})); toast(d.error || 'Could not delete promo code.', { kind: 'error' }) }
    } catch { toast('Network error.', { kind: 'error' }) }
    setBusy(null)
  }

  const cols = isSA ? ['Location', 'Code', 'Discount', 'Start', 'End', 'Max Uses', 'Per Diner', 'Status', ''] : ['Code', 'Discount', 'Start', 'End', 'Max Uses', 'Per Diner', 'Status', '']
  const span = cols.length

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 4px' }}>Promo Codes</h1>
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Create and manage discount codes customers can apply at checkout. Your restaurant funds the discount.</p>
        </div>
        <button onClick={() => setModal({ mode: 'create' })}
          style={{ flexShrink: 0, background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
          + Create Promo Code
        </button>
      </div>

      {isSA && locations.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>Location</span>
          <select value={locationFilter} onChange={e => setLocationFilter(e.target.value)}
            style={{ ...inputSt, width: 'auto', minWidth: 220, padding: '7px 10px' }}>
            <option value="">All my locations ({locations.length})</option>
            {locations.map(l => <option key={l.reference} value={l.reference}>{l.name || l.reference.slice(0, 8)}</option>)}
          </select>
        </div>
      )}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {cols.map((h, i) => <th key={i} style={{ ...colHead, textAlign: i === cols.length - 1 ? 'right' : 'left' }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={span} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>Loading…</td></tr>}
            {!loading && codes.length === 0 && <tr><td colSpan={span} style={{ ...cell, textAlign: 'center', color: '#aaa' }}>No promo codes yet.</td></tr>}
            {!loading && codes.map(c => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                {isSA && <td style={{ ...cell, color: '#666' }}>{c.restaurantName || c.restaurantRef.slice(0, 8)}</td>}
                <td style={{ ...cell, fontWeight: 700 }}>{c.code}</td>
                <td style={cell}>{c.discountPercentage}%</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(c.startDate)}</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(c.endDate)}</td>
                <td style={cell}>
                  {c.maxAvailable ?? '—'}
                  {c.remainingAvailable != null && <span style={{ color: '#aaa' }}> ({c.remainingAvailable} left)</span>}
                </td>
                <td style={cell}>{c.maxPerDiner ?? 1}</td>
                <td style={cell}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: c.active ? '#E6F6EC' : '#F0F0F0', color: c.active ? '#1E7D46' : '#999' }}>
                    {c.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setModal({ mode: 'edit', code: c })} disabled={busy === c.id}
                    style={actBtn('#5B6FE8')}>Edit</button>
                  <button onClick={() => toggleActive(c)} disabled={busy === c.id}
                    style={actBtn('#8A6D1A')}>{c.active ? 'Deactivate' : 'Activate'}</button>
                  <button onClick={() => remove(c)} disabled={busy === c.id}
                    style={actBtn('#E53935')}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <CodeModal
          mode={modal.mode}
          existing={modal.mode === 'edit' ? modal.code : null}
          isSA={isSA}
          locations={locations}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}

// ── Create / edit modal ───────────────────────────────────────────────────────
function CodeModal({ mode, existing, isSA, locations, onClose, onSaved }: {
  mode: 'create' | 'edit'; existing: PromoCode | null; isSA: boolean; locations: Location[]; onClose: () => void; onSaved: () => void
}) {
  const [code, setCode] = useState(existing?.code || '')
  const [discount, setDiscount] = useState(existing ? String(existing.discountPercentage) : '')
  const [startDate, setStartDate] = useState(existing?.startDate || '')
  const [endDate, setEndDate] = useState(existing?.endDate || '')
  const [maxAvailable, setMaxAvailable] = useState(existing?.maxAvailable != null ? String(existing.maxAvailable) : '')
  const [maxPerDiner, setMaxPerDiner] = useState(existing ? String(existing.maxPerDiner) : '1')
  const [location, setLocation] = useState(existing?.restaurantRef || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isEdit = mode === 'edit'

  async function submit() {
    setError('')
    const cleanCode = code.trim().toUpperCase()
    if (!isEdit) {
      if (!cleanCode || !/^[A-Z0-9]+$/.test(cleanCode)) { setError('Code is required and must be uppercase letters/numbers only.'); return }
      if (isSA && !location) { setError('Select a location for this promo code.'); return }
    }
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
      const res = isEdit
        ? await fetch(`/api/restaurant/promo-codes/${existing!.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ discountPercentage: pct, startDate, endDate, maxAvailable: maxAvail, maxPerDiner: perDiner }),
          })
        : await fetch('/api/restaurant/promo-codes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: cleanCode, discountPercentage: pct, startDate, endDate, maxAvailable: maxAvail, maxPerDiner: perDiner, ...(isSA ? { restaurantReference: location } : {}) }),
          })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not save promo code.'); setSaving(false); return }
      toast(isEdit ? `Updated ${cleanCode || existing?.code}` : `Created ${cleanCode}`, { kind: 'success' })
      onSaved()
    } catch { setError('Network error. Please try again.'); setSaving(false) }
  }

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: F }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 16, padding: '26px 28px', maxWidth: 460, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: DARK, margin: '0 0 18px' }}>{isEdit ? `Edit ${existing?.code}` : 'Create Promo Code'}</h2>

        {isSA && !isEdit && (
          <Field label="Location">
            <select value={location} onChange={e => setLocation(e.target.value)} style={inputSt}>
              <option value="">Select a location…</option>
              {locations.map(l => (
                <option key={l.reference} value={l.reference}>{l.name || l.reference.slice(0, 8)}</option>
              ))}
            </select>
          </Field>
        )}
        {isSA && isEdit && <Field label="Location"><div style={{ ...inputSt, background: '#f7f7f9', color: '#666' }}>{existing?.restaurantName || existing?.restaurantRef.slice(0, 8)}</div></Field>}

        <Field label="Code">
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="SUMMER25" style={{ ...inputSt, ...(isEdit ? { background: '#f7f7f9', color: '#666' } : {}) }} disabled={isEdit} />
        </Field>
        <Field label="Discount %">
          <input type="number" min="1" max="100" step="1" value={discount} onChange={e => setDiscount(e.target.value)} placeholder="10" style={inputSt} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Start Date"><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputSt} /></Field>
          <Field label="End Date"><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputSt} /></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Max Available"><input type="number" min="1" step="1" value={maxAvailable} onChange={e => setMaxAvailable(e.target.value)} placeholder="100" style={inputSt} /></Field>
          <Field label="Max Per Diner"><input type="number" min="1" step="1" value={maxPerDiner} onChange={e => setMaxPerDiner(e.target.value)} placeholder="1" style={inputSt} /></Field>
        </div>

        {error && <div style={{ background: '#fff3f3', color: '#c0392b', padding: '10px 12px', borderRadius: 8, marginTop: 6, fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} disabled={saving}
            style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', color: '#444', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={submit} disabled={saving}
            style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: F, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Promo Code'}
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

const actBtn = (color: string): React.CSSProperties => ({ background: 'none', border: 'none', color, cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', fontWeight: 600 })
const inputSt: React.CSSProperties = { width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', boxSizing: 'border-box' }
const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
