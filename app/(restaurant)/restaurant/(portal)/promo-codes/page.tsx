'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast, confirmDialog } from '../../../../components/ui/feedback'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const PAGE_BG = '#F7F8FC'

// Above this, saving requires an explicit "are you sure" — not a hard block (100%
// off is still allowed), just a deliberate second click so a restaurant can't
// fat-finger a giveaway. Percentage only; a flat-$ amount is bounded by the order
// total automatically (floors at $0), so there's no equivalent "100%-off" typo risk.
const HIGH_DISCOUNT_PCT_THRESHOLD = 90

interface PromoCode {
  id: number
  code: string
  discountType: 'flat' | 'percent'
  discountValue: number
  maxDiscountCap: number | null
  minOrderSubtotal: number | null
  firstTimeOnly: boolean
  validFrom: string
  validUntil: string
  maxUses: number | null
  remainingUses: number | null
  maxUsesPerUser: number
  notes: string
  active: boolean
  restaurantRef: string
  restaurantName: string
  moneyFlow: string | null
  /** Shared by codes created together at several locations (null for a one-location code). */
  groupRef: string | null
  usesCount: number
}
interface Location { reference: string; name: string; moneyFlow: string | null }

function fmtDate(s: string): string {
  if (!s) return '—'
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!iso) return s
  const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtDiscount(c: PromoCode): string {
  return c.discountType === 'percent' ? `${c.discountValue}%` : `$${c.discountValue.toFixed(2)}`
}
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A code created at several locations at once is ONE code in the list (Peter, 2026-11-23): its rows share groupRef. The
// list shows one row for the group (its first location's settings, which all share) and a per-location view on demand.
// Edit, Activate/Deactivate and Delete go to one id; the API applies them to every location of the group you manage.
interface CodeGroup { key: string; lead: PromoCode; members: PromoCode[] }
function groupCodes(codes: PromoCode[]): CodeGroup[] {
  const out: CodeGroup[] = []
  const byGroup = new Map<string, CodeGroup>()
  for (const c of codes) {
    if (!c.groupRef) { out.push({ key: `id:${c.id}`, lead: c, members: [c] }); continue }
    const g = byGroup.get(c.groupRef)
    if (g) { g.members.push(c); continue }
    const ng = { key: `g:${c.groupRef}`, lead: c, members: [c] }
    byGroup.set(c.groupRef, ng); out.push(ng)
  }
  for (const g of out) g.members.sort((a, b) => (a.restaurantName || '').localeCompare(b.restaurantName || ''))
  return out
}

export default function PromoCodesPage() {
  const [codes, setCodes] = useState<PromoCode[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [isSA, setIsSA] = useState(false)
  const [loading, setLoading] = useState(true)
  const [locationFilter, setLocationFilter] = useState('')
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; code: PromoCode; members: PromoCode[] } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = (key: string) => setExpanded((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n })

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

  async function toggleActive(g: CodeGroup) {
    const c = g.lead
    // A group reads Active only when every location is; the button sets them all to the same state.
    const allActive = g.members.every((m) => m.active)
    setBusy(c.id)
    try {
      const res = await fetch(`/api/restaurant/promo-codes/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !allActive }),
      })
      if (res.ok) { toast(`${allActive ? 'Promo code deactivated' : 'Promo code activated'}${g.members.length > 1 ? ` at ${g.members.length} locations` : ''}`, { kind: 'success' }); load() }
      else { const d = await res.json().catch(() => ({})); toast(d.error || 'Could not update promo code.', { kind: 'error' }) }
    } catch { toast('Network error.', { kind: 'error' }) }
    setBusy(null)
  }

  async function remove(g: CodeGroup) {
    const c = g.lead
    const where = g.members.length > 1 ? ` at all ${g.members.length} locations` : ''
    const ok = await confirmDialog(`Delete promo code “${c.code}”${where}? This cannot be undone.`, { title: 'Delete promo code', confirmText: 'Delete', danger: true })
    if (!ok) return
    setBusy(c.id)
    try {
      const res = await fetch(`/api/restaurant/promo-codes/${c.id}`, { method: 'DELETE' })
      if (res.ok) { const d = await res.json().catch(() => ({})); toast(d.deactivated ? 'Code had redemptions — deactivated instead' : 'Promo code deleted', { kind: 'success' }); load() }
      else { const d = await res.json().catch(() => ({})); toast(d.error || 'Could not delete promo code.', { kind: 'error' }) }
    } catch { toast('Network error.', { kind: 'error' }) }
    setBusy(null)
  }

  const cols = isSA
    ? ['Location', 'Code', 'Discount', 'Min Order', 'Valid From', 'Valid Until', 'Uses', 'Per Diner', 'First-Time', 'Status', '']
    : ['Code', 'Discount', 'Min Order', 'Valid From', 'Valid Until', 'Uses', 'Per Diner', 'First-Time', 'Status', '']
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
            {!loading && groupCodes(codes).flatMap(g => {
              const c = g.lead
              const multi = g.members.length > 1
              const allActive = g.members.every((m) => m.active)
              const anyActive = g.members.some((m) => m.active)
              const open = expanded.has(g.key)
              const rows = [
              <tr key={g.key} style={{ opacity: anyActive ? 1 : 0.55 }}>
                {isSA && (
                  <td style={{ ...cell, color: '#666' }}>
                    {multi ? (
                      <button onClick={() => toggleExpanded(g.key)} aria-expanded={open}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: BLUE, fontWeight: 600, fontSize: 13, fontFamily: F }}>
                        {g.members.length} locations {open ? '▾' : '▸'}
                      </button>
                    ) : (c.restaurantName || c.restaurantRef.slice(0, 8))}
                  </td>
                )}
                <td style={{ ...cell, fontWeight: 700 }}>{c.code}</td>
                <td style={cell}>
                  {fmtDiscount(c)}
                  {c.maxDiscountCap != null && <span style={{ color: '#aaa' }}> (cap ${c.maxDiscountCap.toFixed(2)})</span>}
                </td>
                <td style={{ ...cell, color: '#666' }}>{c.minOrderSubtotal != null ? `$${c.minOrderSubtotal.toFixed(2)}` : '—'}</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(c.validFrom)}</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(c.validUntil)}</td>
                <td style={cell}>
                  {c.maxUses ?? '—'}
                  {multi
                    ? (c.maxUses != null && <span style={{ color: '#aaa' }}> each</span>)
                    : (c.remainingUses != null && <span style={{ color: '#aaa' }}> ({c.remainingUses} left)</span>)}
                </td>
                <td style={cell}>{c.maxUsesPerUser ?? 1}</td>
                <td style={{ ...cell, textAlign: 'center' }}>{c.firstTimeOnly ? '✓' : '—'}</td>
                <td style={cell}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: allActive ? '#E6F6EC' : '#F0F0F0', color: allActive ? '#1E7D46' : '#999' }}>
                    {allActive ? 'Active' : anyActive ? 'Partly active' : 'Inactive'}
                  </span>
                </td>
                <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setModal({ mode: 'edit', code: c, members: g.members })} disabled={busy === c.id}
                    style={actBtn('#5B6FE8')}>Edit</button>
                  <button onClick={() => toggleActive(g)} disabled={busy === c.id}
                    style={actBtn('#8A6D1A')}>{allActive ? 'Deactivate' : 'Activate'}</button>
                  <button onClick={() => remove(g)} disabled={busy === c.id}
                    style={actBtn('#E53935')}>Delete</button>
                </td>
              </tr>,
              ]
              // Per-location view of a grouped code: each location's own status and uses.
              if (multi && open) {
                for (const m of g.members) {
                  rows.push(
                    <tr key={`${g.key}:${m.id}`} style={{ background: '#FAFAFD', opacity: m.active ? 1 : 0.55 }}>
                      <td style={{ ...cell, paddingLeft: 28, color: '#666' }}>{m.restaurantName || m.restaurantRef.slice(0, 8)}</td>
                      <td style={{ ...cell, color: '#999' }}>{m.code}</td>
                      <td colSpan={4} style={{ ...cell, color: '#999' }}>Same settings as the code above</td>
                      <td style={cell}>
                        {m.usesCount} used
                        {m.remainingUses != null && <span style={{ color: '#aaa' }}> ({m.remainingUses} left)</span>}
                      </td>
                      <td colSpan={2} style={cell} />
                      <td style={cell}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: m.active ? '#E6F6EC' : '#F0F0F0', color: m.active ? '#1E7D46' : '#999' }}>
                          {m.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={cell} />
                    </tr>,
                  )
                }
              }
              return rows
            })}
          </tbody>
        </table>
      </div>

      {modal && (
        <CodeModal
          mode={modal.mode}
          existing={modal.mode === 'edit' ? modal.code : null}
          members={modal.mode === 'edit' ? modal.members : []}
          isSA={isSA}
          locations={locations}
          defaultLocation={locationFilter}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}

// ── Create / edit modal ───────────────────────────────────────────────────────
function CodeModal({ mode, existing, members, isSA, locations, defaultLocation, onClose, onSaved }: {
  mode: 'create' | 'edit'; existing: PromoCode | null; members: PromoCode[]; isSA: boolean; locations: Location[]; defaultLocation: string
  onClose: () => void; onSaved: () => void
}) {
  const [code, setCode] = useState(existing?.code || '')
  const [discountType, setDiscountType] = useState<'flat' | 'percent'>(existing?.discountType || 'percent')
  const [discountValue, setDiscountValue] = useState(existing ? String(existing.discountValue) : '')
  const [maxDiscountCap, setMaxDiscountCap] = useState(existing?.maxDiscountCap != null ? String(existing.maxDiscountCap) : '')
  const [minOrderSubtotal, setMinOrderSubtotal] = useState(existing?.minOrderSubtotal != null ? String(existing.minOrderSubtotal) : '')
  const [maxUses, setMaxUses] = useState(existing?.maxUses != null ? String(existing.maxUses) : '')
  const [maxUsesPerUser, setMaxUsesPerUser] = useState(existing ? String(existing.maxUsesPerUser) : '1')
  const [firstTimeOnly, setFirstTimeOnly] = useState(existing?.firstTimeOnly ?? false)
  const [validFrom, setValidFrom] = useState(existing?.validFrom || todayIso())
  const [validUntil, setValidUntil] = useState(existing?.validUntil || '')
  const [notes, setNotes] = useState(existing?.notes || '')
  // Create, System Admin: the locations this code is made at (one row each, grouped). Starts on the location filtered to.
  const [selected, setSelected] = useState<string[]>(defaultLocation ? [defaultLocation] : [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isEdit = mode === 'edit'

  async function submit(confirmHighDiscount = false) {
    setError('')
    const cleanCode = code.trim().toUpperCase()
    if (!isEdit) {
      if (!cleanCode || !/^[A-Z0-9]+$/.test(cleanCode)) { setError('Code is required and must be uppercase letters/numbers only.'); return }
      if (isSA && !selected.length) { setError('Select at least one location for this promo code.'); return }
    }
    const value = parseFloat(discountValue)
    if (discountType === 'percent') {
      if (!Number.isFinite(value) || value < 1 || value > 100) { setError('Discount must be a number between 1 and 100.'); return }
    } else {
      if (!Number.isFinite(value) || value <= 0) { setError('Discount must be a dollar amount greater than 0.'); return }
    }
    if (!validFrom) { setError('Valid-from date is required.'); return }
    if (validUntil && validUntil < validFrom) { setError('Valid-until date must be on or after valid-from.'); return }
    const perUser = maxUsesPerUser.trim() ? parseInt(maxUsesPerUser, 10) : 1
    if (!Number.isInteger(perUser) || perUser < 1) { setError('Max uses per diner must be a whole number of 1 or more.'); return }
    if (maxUses.trim()) {
      const m = parseInt(maxUses, 10)
      if (!Number.isInteger(m) || m < 1) { setError('Max total uses must be a whole number of 1 or more, or left blank for unlimited.'); return }
    }

    // 100%-off guard: not a hard block, just an explicit second confirmation above
    // the threshold — see HIGH_DISCOUNT_PCT_THRESHOLD.
    if (!confirmHighDiscount && discountType === 'percent' && value >= HIGH_DISCOUNT_PCT_THRESHOLD) {
      const ok = await confirmDialog(
        `${value}% off is a very deep discount — customers could pay almost nothing. Are you sure you want to save this code?`,
        { title: 'Confirm high discount', confirmText: 'Yes, save it', danger: true },
      )
      if (!ok) return
    }

    const payload: Record<string, unknown> = isEdit
      ? {
          discountType, discountValue: value,
          maxDiscountCap: discountType === 'percent' && maxDiscountCap.trim() ? parseFloat(maxDiscountCap) : null,
          minOrderSubtotal: minOrderSubtotal.trim() ? parseFloat(minOrderSubtotal) : null,
          firstTimeOnly, notes: notes.trim() || null,
          validFrom, validUntil: validUntil || null,
          maxUses: maxUses.trim() ? parseInt(maxUses, 10) : null,
          maxUsesPerUser: perUser,
          confirmHighDiscount: true,
        }
      : {
          code: cleanCode, discountType, discountValue: value,
          maxDiscountCap: discountType === 'percent' && maxDiscountCap.trim() ? parseFloat(maxDiscountCap) : null,
          minOrderSubtotal: minOrderSubtotal.trim() ? parseFloat(minOrderSubtotal) : null,
          firstTimeOnly, notes: notes.trim() || null,
          validFrom, validUntil: validUntil || null,
          maxUses: maxUses.trim() ? parseInt(maxUses, 10) : null,
          maxUsesPerUser: perUser,
          confirmHighDiscount: true,
          ...(isSA ? { restaurantReferences: selected } : {}),
        }

    setSaving(true)
    try {
      const res = isEdit
        ? await fetch(`/api/restaurant/promo-codes/${existing!.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/restaurant/promo-codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not save promo code.'); setSaving(false); return }
      const n = isEdit ? Number(d.updated || 1) : (Array.isArray(d.codes) ? d.codes.length : 1)
      toast(`${isEdit ? `Updated ${cleanCode || existing?.code}` : `Created ${cleanCode}`}${n > 1 ? ` at ${n} locations` : ''}`, { kind: 'success' })
      onSaved()
    } catch { setError('Network error. Please try again.'); setSaving(false) }
  }

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: F }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 16, padding: '26px 28px', maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: DARK, margin: '0 0 18px' }}>{isEdit ? `Edit ${existing?.code}` : 'Create Promo Code'}</h2>

        {isSA && !isEdit && (
          <Field label="Locations">
            <LocationMultiSelect locations={locations} selected={selected} onChange={setSelected} />
          </Field>
        )}
        {isSA && isEdit && (
          <Field label={members.length > 1 ? `Locations (${members.length}) — changes apply to all` : 'Location'}>
            <div style={{ ...inputSt, background: '#f7f7f9', color: '#666' }}>
              {(members.length ? members : existing ? [existing] : []).map((m) => m.restaurantName || m.restaurantRef.slice(0, 8)).join(', ')}
            </div>
          </Field>
        )}

        <Field label="Code">
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="SUMMER25" style={{ ...inputSt, ...(isEdit ? { background: '#f7f7f9', color: '#666' } : {}) }} disabled={isEdit} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Discount Type">
            <select value={discountType} onChange={e => setDiscountType(e.target.value as 'flat' | 'percent')} style={inputSt}>
              <option value="percent">Percentage %</option>
              <option value="flat">Flat $</option>
            </select>
          </Field>
          <Field label={discountType === 'percent' ? 'Discount Value (%)' : 'Discount Value ($)'}>
            <input type="number" min={discountType === 'percent' ? 1 : 0.01} max={discountType === 'percent' ? 100 : undefined} step="0.01"
              value={discountValue} onChange={e => setDiscountValue(e.target.value)} placeholder={discountType === 'percent' ? '10' : '5.00'} style={inputSt} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {discountType === 'percent' && (
            <Field label="Max Discount Cap ($, optional)">
              <input type="number" min="0" step="0.01" value={maxDiscountCap} onChange={e => setMaxDiscountCap(e.target.value)} placeholder="No cap" style={inputSt} />
            </Field>
          )}
          <Field label="Min Order Subtotal ($, optional)">
            <input type="number" min="0" step="0.01" value={minOrderSubtotal} onChange={e => setMinOrderSubtotal(e.target.value)} placeholder="None" style={inputSt} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Valid From"><input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} style={inputSt} /></Field>
          <Field label="Valid Until (optional)"><input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} style={inputSt} /></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Max Total Uses (blank = unlimited)"><input type="number" min="1" step="1" value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="Unlimited" style={inputSt} /></Field>
          <Field label="Max Uses Per Diner"><input type="number" min="1" step="1" value={maxUsesPerUser} onChange={e => setMaxUsesPerUser(e.target.value)} placeholder="1" style={inputSt} /></Field>
        </div>
        <Field label="Notes (internal, optional)">
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Internal note" style={inputSt} />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 14, fontSize: 13, color: DARK, cursor: 'pointer' }}>
          <input type="checkbox" checked={firstTimeOnly} onChange={e => setFirstTimeOnly(e.target.checked)} style={{ accentColor: BLUE, width: 16, height: 16 }} />
          First-time customers only (at this restaurant)
        </label>

        {error && <div style={{ background: '#fff3f3', color: '#c0392b', padding: '10px 12px', borderRadius: 8, marginTop: 6, fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} disabled={saving}
            style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', color: '#444', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={() => submit(false)} disabled={saving}
            style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: F, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Promo Code'}
          </button>
        </div>
      </div>
    </div>
  )
}

// The System Admin's locations — only the ones the API already lists for them (no change to who manages what) — with a
// search box and "Select all" (which acts on the locations the search shows).
function LocationMultiSelect({ locations, selected, onChange }: { locations: Location[]; selected: string[]; onChange: (refs: string[]) => void }) {
  const [q, setQ] = useState('')
  const shown = locations.filter((l) => (l.name || l.reference).toLowerCase().includes(q.trim().toLowerCase()))
  const allShown = shown.length > 0 && shown.every((l) => selected.includes(l.reference))
  const toggleAll = () => {
    const shownRefs = shown.map((l) => l.reference)
    onChange(allShown ? selected.filter((r) => !shownRefs.includes(r)) : [...new Set([...selected, ...shownRefs])])
  }
  const toggle = (ref: string) => onChange(selected.includes(ref) ? selected.filter((r) => r !== ref) : [...selected, ref])
  return (
    <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search locations" aria-label="Search locations"
          style={{ ...inputSt, padding: '7px 10px', border: '1px solid #e6e6ee' }} />
        <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>{selected.length} selected</span>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, fontWeight: 600, color: DARK, cursor: 'pointer', borderBottom: '1px solid #f0f0f0', background: '#FAFAFD' }}>
        <input type="checkbox" checked={allShown} onChange={toggleAll} disabled={!shown.length} style={{ accentColor: BLUE, width: 16, height: 16 }} />
        Select all{q.trim() ? ` (${shown.length} shown)` : ` (${locations.length})`}
      </label>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {shown.map((l) => (
          <label key={l.reference} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 13, color: DARK, cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.includes(l.reference)} onChange={() => toggle(l.reference)} style={{ accentColor: BLUE, width: 16, height: 16 }} />
            {l.name || l.reference.slice(0, 8)}
          </label>
        ))}
        {!shown.length && <div style={{ padding: '10px 12px', fontSize: 13, color: '#aaa' }}>No locations match.</div>}
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
