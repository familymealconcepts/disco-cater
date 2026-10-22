'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'

// Super Admin → Restaurant Admins. Every System Admin and every Admin in one
// list (Peter, 22 Oct 2026 — replaces the separate System Admins and Admins
// pages). Tier: Primary / Regional (SYSTEM_ADMIN) and Single (ADMIN,
// Restaurant Staff on one location). Locations are Disco's single list.
//
// Everything here writes to Disco only — never to FamilyMeal.

const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const F = "'DM Sans', sans-serif"

type Tier = 'PRIMARY' | 'REGIONAL' | 'SINGLE'
interface Loc { reference: string; name: string | null }
interface Person {
  email: string; firstName: string; lastName: string
  role: 'SYSTEM_ADMIN' | 'ADMIN'; tier: Tier; source: 'DISCO' | 'FM'
  hasDiscoAccount: boolean; hasDiscoPassword: boolean; invitedBy: string | null
  locations: Loc[]
}
interface Totals { all: number; primary: number; regional: number; single: number; systemAdminsWithNoLocations: number }
interface CacheRow { reference: string; name: string; address: string }

const cell: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 13.5, verticalAlign: 'top' }
const colHead: React.CSSProperties = { padding: '9px 12px', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#777', borderBottom: '1px solid #e5e5e5', textAlign: 'left', background: '#fafafc' }
const pill = (bg: string, fg: string): React.CSSProperties => ({ display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: 0.3, padding: '2px 7px', borderRadius: 4, background: bg, color: fg })
const btn: React.CSSProperties = { padding: '6px 11px', borderRadius: 7, border: '1px solid #ddd', background: '#fff', color: '#333', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: F }
const primaryBtn: React.CSSProperties = { ...btn, background: BLUE, borderColor: BLUE, color: '#fff' }
const TIER_PILL: Record<Tier, React.CSSProperties> = {
  PRIMARY: pill('#fbeffb', '#9c3aa3'), REGIONAL: pill('#eef0ff', '#4a4fd0'), SINGLE: pill('#f3f3f3', '#666'),
}
const TIER_LABEL: Record<Tier, string> = { PRIMARY: 'Primary', REGIONAL: 'Regional', SINGLE: 'Single' }

export default function RestaurantAdminsPage() {
  const [rows, setRows] = useState<Person[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [q, setQ] = useState('')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [editing, setEditing] = useState<Person | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/restaurant-admins', { cache: 'no-store' })
      if (!res.ok) { setError('Could not load restaurant admins.'); return }
      const d = await res.json()
      setRows(Array.isArray(d?.people) ? d.people : [])
      setTotals(d?.totals ?? null)
    } catch { setError('Could not load restaurant admins.') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!term) return true
      return `${r.firstName} ${r.lastName} ${r.email} ${r.locations.map(l => l.name || '').join(' ')}`.toLowerCase().includes(term)
    })
  }, [rows, q, tierFilter])

  async function act(p: Person, url: string, init: RequestInit, ok: string) {
    setError(''); setNotice('')
    const res = await fetch(url, init)
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d?.error || 'That did not work.'); return false }
    setNotice(ok); return true
  }
  const enc = (e: string) => encodeURIComponent(e)

  async function resend(p: Person) {
    await act(p, `/api/admin/restaurant-admins/${enc(p.email)}/set-password`, { method: 'POST' }, `Set-password email sent to ${p.email}.`)
  }
  async function remove(p: Person) {
    if (!window.confirm(`Remove ${p.email}? Their Disco location list is cleared and their Disco account archived. FamilyMeal is not changed.`)) return
    if (await act(p, `/api/admin/restaurant-admins/${enc(p.email)}`, { method: 'DELETE' }, `${p.email} removed.`)) load()
  }
  async function setPrimary(p: Person, primary: boolean) {
    const msg = primary
      ? `Make ${p.email} the Primary? The current Primary of this group keeps their locations but loses the tag, and ${p.email} gains every location they held.`
      : `Remove the Primary tag from ${p.email}? Their locations are not changed.`
    if (!window.confirm(msg)) return
    if (await act(p, `/api/admin/restaurant-admins/${enc(p.email)}/primary`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ primary }),
    }, primary ? `${p.email} is now the Primary.` : `${p.email} is no longer the Primary.`)) load()
  }

  return (
    <div style={{ fontFamily: F, padding: '28px 30px', maxWidth: 1280 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Restaurant Admins</h1>
        <a href="/admin/manage-admins" style={{ marginLeft: 'auto', fontSize: 13, color: BLUE, fontWeight: 600 }}>+ Add System Admin</a>
      </div>
      <p style={{ fontSize: 13.5, color: '#777', margin: '0 0 18px', maxWidth: '78ch', lineHeight: 1.6 }}>
        Every System Admin and Admin. <strong>Primary</strong> holds every location in their group and only a Super Admin moves it;
        <strong> Regional</strong> holds what they were assigned; <strong>Single</strong> is Restaurant Staff on one location.
        Locations are Disco Cater’s list — FamilyMeal is never changed from here.
      </p>

      {totals && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '14px 18px', background: '#f7f8fb', border: '1px solid #e6e8f0', borderRadius: 10, marginBottom: 18 }}>
          {([['People', totals.all], ['Primary', totals.primary], ['Regional', totals.regional], ['Single', totals.single], ['System Admins with no locations', totals.systemAdminsWithNoLocations]] as const).map(([label, v]) => (
            <div key={label} style={{ minWidth: 110 }}>
              <div style={{ fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#888', marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 21, fontWeight: 700, color: DARK }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, email or location…" aria-label="Search"
          style={{ flex: '1 1 260px', minWidth: 200, padding: '9px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13.5, fontFamily: F }} />
        {(['ALL', 'PRIMARY', 'REGIONAL', 'SINGLE'] as const).map(t => (
          <button key={t} onClick={() => setTierFilter(t)}
            style={{ padding: '7px 13px', borderRadius: 999, border: `1px solid ${tierFilter === t ? BLUE : '#ddd'}`, background: tierFilter === t ? BLUE : '#fff', color: tierFilter === t ? '#fff' : '#555', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
            {t === 'ALL' ? 'All' : TIER_LABEL[t]}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#999' }}>{shown.length} of {rows.length}</span>
      </div>

      {error && <div role="alert" style={{ padding: 12, background: '#fdecea', border: '1px solid #f5c6c2', borderRadius: 8, color: '#8a2a21', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {notice && <div role="status" style={{ padding: 12, background: '#e8f5ee', border: '1px solid #bfe3cf', borderRadius: 8, color: '#0F5F3C', fontSize: 13, marginBottom: 12 }}>{notice}</div>}

      <div className="dc-xscroll" style={{ border: '1px solid #eee', borderRadius: 10, overflowX: 'auto', background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Tier</th>
              <th style={colHead}>Locations</th>
              <th style={colHead}>Login</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !shown.length && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>No one matches.</td></tr>}
            {!loading && shown.map(p => (
              <tr key={p.email} data-email={p.email}>
                <td style={{ ...cell, fontWeight: 600, color: DARK }}>{`${p.firstName} ${p.lastName}`.trim() || p.email.split('@')[0]}</td>
                <td style={{ ...cell, color: '#555' }}>{p.email}</td>
                <td style={cell}><span style={TIER_PILL[p.tier]}>{TIER_LABEL[p.tier]}</span></td>
                <td style={cell}>
                  <div style={{ fontWeight: 700 }}>{p.locations.length}</div>
                  {p.locations.length > 0 && (
                    <div style={{ fontSize: 11.5, color: '#888', lineHeight: 1.4, marginTop: 2, maxWidth: 360 }} title={p.locations.map(l => l.name || l.reference).join('\n')}>
                      {p.locations.slice(0, 3).map(l => l.name || l.reference.slice(0, 8)).join(', ')}
                      {p.locations.length > 3 ? `, +${p.locations.length - 3} more` : ''}
                    </div>
                  )}
                </td>
                <td style={cell}>
                  {!p.hasDiscoAccount ? <span style={pill('#f3f3f3', '#999')}>FAMILYMEAL ONLY</span>
                    : p.hasDiscoPassword ? <span style={pill('#e8f5ee', '#0F7B4F')}>DISCO PASSWORD</span>
                      : <span style={pill('#fff4e0', '#9A6212')}>NO PASSWORD YET</span>}
                </td>
                <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button style={btn} onClick={() => { setError(''); setNotice(''); setEditing(p) }}>Edit</button>
                    {p.role === 'SYSTEM_ADMIN' && p.hasDiscoAccount && (
                      p.tier === 'PRIMARY'
                        ? <button style={btn} onClick={() => setPrimary(p, false)}>Unset Primary</button>
                        : <button style={btn} onClick={() => setPrimary(p, true)}>Make Primary</button>
                    )}
                    <button style={btn} disabled={!p.hasDiscoAccount} title={p.hasDiscoAccount ? 'Send the set-password email' : 'No Disco account — FamilyMeal owns this login'}
                      onClick={() => resend(p)}>Resend set-password</button>
                    <button style={{ ...btn, color: '#C62828' }} onClick={() => remove(p)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <EditDialog person={editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); setNotice(m); load() }} />}
    </div>
  )
}

function EditDialog({ person, onClose, onSaved }: { person: Person; onClose: () => void; onSaved: (msg: string) => void }) {
  const [first, setFirst] = useState(person.firstName)
  const [last, setLast] = useState(person.lastName)
  const [refs, setRefs] = useState<string[]>(person.locations.map(l => l.reference))
  const [all, setAll] = useState<CacheRow[]>([])
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const single = person.role === 'ADMIN'
  const editable = person.hasDiscoAccount || person.role === 'SYSTEM_ADMIN'

  useEffect(() => {
    fetch('/api/admin/restaurant-cache/list').then(r => r.ok ? r.json() : null)
      .then(d => setAll(Array.isArray(d?.restaurants) ? d.restaurants : [])).catch(() => {})
  }, [])
  const nameOf = useMemo(() => {
    const m = new Map(all.map(r => [r.reference, r.name]))
    for (const l of person.locations) if (l.name && !m.has(l.reference)) m.set(l.reference, l.name)
    return m
  }, [all, person.locations])
  const candidates = useMemo(() => {
    const t = filter.trim().toLowerCase()
    if (!t) return []
    return all.filter(r => !refs.includes(r.reference) && `${r.name} ${r.address}`.toLowerCase().includes(t)).slice(0, 30)
  }, [all, filter, refs])

  async function save() {
    setSaving(true); setErr('')
    try {
      const body: Record<string, unknown> = { restaurantReferences: refs }
      if (person.hasDiscoAccount) { body.firstName = first; body.lastName = last }
      if (single && refs.length !== 1) { setErr('A Single admin has exactly one location.'); return }
      const res = await fetch(`/api/admin/restaurant-admins/${encodeURIComponent(person.email)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Could not save.'); return }
      onSaved(`Saved ${person.email}.`)
    } finally { setSaving(false) }
  }

  const input: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 13.5, fontFamily: F, boxSizing: 'border-box' }
  return (
    <div onClick={() => !saving && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(20,16,40,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div role="dialog" aria-label="Edit restaurant admin" onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, width: 'min(640px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 22, fontFamily: F }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, color: DARK }}>{person.email}</h2>
        <div style={{ marginBottom: 14 }}><span style={TIER_PILL[person.tier]}>{TIER_LABEL[person.tier]}</span>
          {!person.hasDiscoAccount && <span style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>FamilyMeal-only — no Disco account, so no name to edit here.</span>}
        </div>
        {person.hasDiscoAccount && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 200px', fontSize: 12, color: '#666' }}>First name<input style={input} value={first} onChange={e => setFirst(e.target.value)} /></label>
            <label style={{ flex: '1 1 200px', fontSize: 12, color: '#666' }}>Last name<input style={input} value={last} onChange={e => setLast(e.target.value)} /></label>
          </div>
        )}
        <div style={{ fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 6 }}>{single ? 'Location (exactly one)' : `Locations (${refs.length})`}</div>
        <div style={{ border: '1px solid #eee', borderRadius: 8, maxHeight: 220, overflow: 'auto', marginBottom: 10 }}>
          {!refs.length && <div style={{ padding: 10, fontSize: 13, color: '#999' }}>No locations.</div>}
          {refs.map(r => (
            <div key={r} style={{ display: 'flex', alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid #f5f5f5', fontSize: 13 }}>
              <span style={{ flex: 1 }}>{nameOf.get(r) || r}</span>
              {editable && <button aria-label={`Remove ${nameOf.get(r) || r}`} onClick={() => setRefs(x => x.filter(y => y !== r))} style={{ ...btn, padding: '2px 8px', color: '#C62828' }}>Remove</button>}
            </div>
          ))}
        </div>
        {editable && (
          <>
            <input style={input} placeholder="Add a location — type to search…" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Find a location" />
            {candidates.length > 0 && (
              <div style={{ border: '1px solid #eee', borderRadius: 8, marginTop: 6, maxHeight: 200, overflow: 'auto' }}>
                {candidates.map(c => (
                  <button key={c.reference} onClick={() => { setRefs(x => single ? [c.reference] : [...x, c.reference]); setFilter('') }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderBottom: '1px solid #f5f5f5', background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: F }}>
                    {c.name} <span style={{ color: '#999', fontSize: 11.5 }}>{c.address}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {err && <div role="alert" style={{ marginTop: 12, color: '#8a2a21', fontSize: 13 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button style={btn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={primaryBtn} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
