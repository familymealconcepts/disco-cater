'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

interface Location { reference: string; name: string; address: string; isLive: boolean; isHome: boolean }
interface SubAdmin { email: string; firstName: string; lastName: string; pendingInvite?: boolean; locations: { reference: string; name: string }[] }

export default function TeamPage() {
  const [locations, setLocations] = useState<Location[]>([])
  const [subAdmins, setSubAdmins] = useState<SubAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  // Add / edit sub-admin modal state. `editing` holds the email when editing an
  // existing sub admin, or '' for a new one.
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SubAdmin | null>(null)
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', refs: [] as string[] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/restaurant/team')
    if (res.status === 403) { setForbidden(true); setLoading(false); return }
    if (res.ok) {
      const d = await res.json()
      setLocations(d.locations || [])
      setSubAdmins(d.subAdmins || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openAdd() {
    setEditing(null)
    setForm({ email: '', firstName: '', lastName: '', refs: [] })
    setError('')
    setModalOpen(true)
  }

  function openEdit(s: SubAdmin) {
    setEditing(s)
    setForm({ email: s.email, firstName: s.firstName, lastName: s.lastName, refs: s.locations.map(l => l.reference) })
    setError('')
    setModalOpen(true)
  }

  function toggleRef(ref: string) {
    setForm(f => ({ ...f, refs: f.refs.includes(ref) ? f.refs.filter(r => r !== ref) : [...f.refs, ref] }))
  }

  async function saveSubAdmin() {
    if (!editing && !form.email.trim()) { setError('Email is required'); return }
    if (!form.refs.length) { setError('Select at least one location'); return }
    setSaving(true); setError('')
    const res = editing
      ? await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(editing.email)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantReferences: form.refs }),
        })
      : await fetch('/api/restaurant/team/sub-admins', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.email, firstName: form.firstName, lastName: form.lastName, restaurantReferences: form.refs }),
        })
    setSaving(false)
    if (res.ok) { setModalOpen(false); load() }
    else { const d = await res.json().catch(() => ({})); setError(d?.error || 'Save failed') }
  }

  async function removeSubAdmin(s: SubAdmin) {
    if (!confirm(`Remove sub system admin ${s.email}? This deletes their account and access.`)) return
    const res = await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(s.email)}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  const [resending, setResending] = useState('')
  async function resendInvite(s: SubAdmin) {
    setResending(s.email)
    const res = await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(s.email)}/resend-invite`, { method: 'POST' })
    setResending('')
    alert(res.ok ? `Invite resent to ${s.email}.` : 'Could not resend the invite.')
  }

  function addNewLocation() {
    // TODO (>2h): launch the become-a-partner flow at Step 2 (skip Step 1 since
    // the PSA is already authenticated), pre-fill their email, and on completion
    // insert the new restaurant_reference into disco_restaurant_location_access
    // for this PSA. For now, deep-link to the existing onboarding flow.
    window.location.href = '/become-a-partner'
  }

  if (forbidden) {
    return <div style={{ padding: '28px 32px', fontFamily: F, color: '#888' }}>This page is only available to System Admins.</div>
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 20px' }}>Team</h1>

      {loading && <div style={{ color: '#888', fontSize: 13 }}>Loading…</div>}

      {!loading && (
        <>
          {/* Section 1 — Locations */}
          <section style={card}>
            <div style={sectionHead}>
              <h2 style={sectionTitle}>Locations</h2>
              <button onClick={addNewLocation} style={primaryBtn}>+ Add New Location</button>
            </div>
            {locations.length === 0 && <div style={{ color: '#999', fontSize: 13, padding: '8px 0' }}>No locations yet.</div>}
            {locations.map(loc => (
              <div key={loc.reference} style={row}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>
                    {loc.name || loc.reference}
                    {loc.isHome && <span style={homePill}>Home</span>}
                  </div>
                  {loc.address && <div style={{ fontSize: 12, color: '#888' }}>{loc.address}</div>}
                </div>
                <span style={loc.isLive ? livePill : offPill}>{loc.isLive ? 'Live' : 'Not live'}</span>
              </div>
            ))}
          </section>

          {/* Section 2 — Sub System Admins */}
          <section style={{ ...card, marginTop: 20 }}>
            <div style={sectionHead}>
              <h2 style={sectionTitle}>Sub System Admins</h2>
              <button onClick={openAdd} style={primaryBtn}>Add Sub System Admin</button>
            </div>
            {subAdmins.length === 0 && <div style={{ color: '#999', fontSize: 13, padding: '8px 0' }}>No sub system admins yet.</div>}
            {subAdmins.map(s => (
              <div key={s.email} style={row}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>
                    {`${s.firstName} ${s.lastName}`.trim() || s.email}
                    {s.pendingInvite && <span style={pendingPill}>Invite pending</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>{s.email}</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                    {s.locations.length ? s.locations.map(l => l.name || l.reference).join(', ') : 'No locations'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  {s.pendingInvite && (
                    <button onClick={() => resendInvite(s)} disabled={resending === s.email} style={linkBtn}>
                      {resending === s.email ? 'Sending…' : 'Resend Invite'}
                    </button>
                  )}
                  <button onClick={() => openEdit(s)} style={linkBtn}>Edit</button>
                  <button onClick={() => removeSubAdmin(s)} style={{ ...linkBtn, color: '#E76F51' }}>Remove</button>
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {modalOpen && (
        <div style={overlay}>
          <div style={modal}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: DARK }}>
              {editing ? 'Edit Sub System Admin' : 'Add Sub System Admin'}
            </h3>
            {!editing && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                <input placeholder="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={input} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <input placeholder="First name" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} style={input} />
                  <input placeholder="Last name" value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} style={input} />
                </div>
              </div>
            )}
            {editing && <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>{editing.email}</div>}

            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>
              Locations <span style={{ color: '#999' }}>({form.refs.length})</span>
            </label>
            <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, maxHeight: 220, overflowY: 'auto', padding: 4 }}>
              {locations.length === 0 && <div style={{ padding: 12, fontSize: 12, color: '#999' }}>You have no locations to assign.</div>}
              {locations.map(loc => {
                const checked = form.refs.includes(loc.reference)
                return (
                  <label key={loc.reference} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: DARK, background: checked ? '#EEF0FD' : 'transparent' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleRef(loc.reference)} style={{ accentColor: BLUE }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc.name || loc.reference}</span>
                  </label>
                )
              })}
            </div>

            {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginTop: 12, fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button onClick={() => setModalOpen(false)} disabled={saving} style={secondaryBtn}>Cancel</button>
              <button onClick={saveSubAdmin} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const card: React.CSSProperties = { background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '18px 20px' }
const sectionHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }
const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: DARK, margin: 0 }
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid #f0f0f0' }
const homePill: React.CSSProperties = { marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#fff', background: BLUE, borderRadius: 6, padding: '2px 7px' }
const pendingPill: React.CSSProperties = { marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#92400E', background: '#FEF3C7', borderRadius: 6, padding: '2px 7px' }
const livePill: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#166534', background: '#DCFCE7', borderRadius: 6, padding: '3px 9px', flexShrink: 0 }
const offPill: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#92400E', background: '#FEF3C7', borderRadius: 6, padding: '3px 9px', flexShrink: 0 }
const primaryBtn: React.CSSProperties = { padding: '9px 16px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
const secondaryBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px' }
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
const modal: React.CSSProperties = { background: '#fff', borderRadius: 14, padding: '24px 28px', maxWidth: 520, width: '100%', maxHeight: '92vh', overflowY: 'auto', fontFamily: F }
const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' }
