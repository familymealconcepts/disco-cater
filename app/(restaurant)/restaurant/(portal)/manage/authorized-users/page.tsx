'use client'
import { useState, useEffect, useCallback } from 'react'

// Authorized Users page — restaurant portal, SYSTEM_ADMIN-only nav item.
// Mirrors FM's admin-manager/authorized-users component pair (list +
// update dialog). See docs/fm-authorized-users-audit.md.

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const INDIGO = '#5B6FE8'
const PAGE_BG = '#F7F8FC'

interface AuthUser {
  reference: string
  firstName: string
  lastName?: string
  email: string
  role: string
  createdDate?: string
  locked?: boolean
  restaurantReferences?: string[]
  restaurant?: { reference: string }
}

interface LocationOption {
  reference: string
  businessName: string
  editable?: boolean
}

// Role enum → display label. FM source: admin-manager/authorized-users/
// authorized-users.component.html:24 + update-authorized-users.component.ts:27-36.
// REGIONAL_ADMIN exists in FM as a third role (paths.constant.ts:81-124) —
// rendered in the list cell if encountered, not offered in the create
// dialog until Project Orca 3.1 confirms it.
const ROLE_DISPLAY: Record<string, string> = {
  SYSTEM_ADMIN: 'System Admin',
  ADMIN: 'Restaurant User',
  REGIONAL_ADMIN: 'Regional Admin',
}

// Two-option role selector mirrors FM's roles array — see audit § A.2.
const ROLE_OPTIONS = [
  { value: 'SYSTEM_ADMIN', label: 'System Admin' },
  { value: 'ADMIN', label: 'Restaurant User' },
] as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface UserForm {
  reference?: string
  firstName: string
  lastName: string
  email: string
  role: 'SYSTEM_ADMIN' | 'ADMIN'
  /** Always stored as array client-side; serialized as array on POST/
   *  PUT per FM's normalized wire format. ADMIN role uses [oneRef]. */
  restaurantReference: string[]
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${String(dt.getFullYear()).slice(-2)}`
  } catch { return d }
}

export default function AuthorizedUsersPage() {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<UserForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  // SYSTEM_ADMIN (Primary System Admin) gets the extra Team-management sections
  // below — their sub system admins + their locations. ADMIN users never see them.
  const [isSystemAdmin, setIsSystemAdmin] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('restaurant_user')
      const role = raw ? JSON.parse(raw)?.role : ''
      setIsSystemAdmin(role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN')
    } catch {}
  }, [])

  // Location picker source — fetched once when the dialog opens.
  const [locations, setLocations] = useState<LocationOption[]>([])
  const [locationsLoading, setLocationsLoading] = useState(false)
  const [locationFilter, setLocationFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
    if (search) params.set('search', search)
    const res = await fetch(`/api/restaurant/authorized-users?${params}`)
    if (res.ok) {
      const data = await res.json()
      setUsers(data.content || [])
      setTotal(data.totalElements || 0)
    } else {
      setUsers([]); setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize, search])

  useEffect(() => { load() }, [load])

  // Fetch the inviter's assigned locations when the dialog opens.
  // FM endpoint: GET /api/system-admin/restaurants/list (scoped by JWT).
  // Cached across open/close within the page session.
  useEffect(() => {
    if (!editing) return
    if (locations.length > 0) return
    let cancelled = false
    setLocationsLoading(true)
    fetch('/api/restaurant/system-admin-restaurants')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        const list = Array.isArray(d) ? d : (d?.content || [])
        setLocations(
          list
            .map((r: LocationOption) => ({ reference: r.reference, businessName: r.businessName, editable: r.editable !== false }))
            .filter((r: LocationOption) => r.reference && r.businessName),
        )
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLocationsLoading(false) })
    return () => { cancelled = true }
  }, [editing, locations.length])

  function openCreate() {
    setFormErr(null)
    setEditing({ firstName: '', lastName: '', email: '', role: 'ADMIN', restaurantReference: [] })
  }

  function openEdit(u: AuthUser) {
    setFormErr(null)
    // Per FM update-authorized-users.component.ts:131-150 — the form
    // patches restaurantReferences[] for SYSTEM_ADMIN and the single
    // restaurant.reference for ADMIN. We normalize to array here.
    const refs = u.role === 'SYSTEM_ADMIN'
      ? (u.restaurantReferences || [])
      : (u.restaurant?.reference ? [u.restaurant.reference] : [])
    setEditing({
      reference: u.reference,
      firstName: u.firstName,
      lastName: u.lastName || '',
      email: u.email,
      role: (u.role === 'SYSTEM_ADMIN' ? 'SYSTEM_ADMIN' : 'ADMIN'),
      restaurantReference: refs,
    })
  }

  function toggleLocation(ref: string) {
    setEditing(prev => {
      if (!prev) return prev
      if (prev.role === 'ADMIN') {
        // Single-select per FM template lines 62-70.
        return { ...prev, restaurantReference: [ref] }
      }
      // Multi-select for SYSTEM_ADMIN.
      const has = prev.restaurantReference.includes(ref)
      return {
        ...prev,
        restaurantReference: has
          ? prev.restaurantReference.filter(r => r !== ref)
          : [...prev.restaurantReference, ref],
      }
    })
  }

  function changeRole(role: 'SYSTEM_ADMIN' | 'ADMIN') {
    setEditing(prev => {
      if (!prev) return prev
      // FM update-authorized-users.component.ts:155-167 doesn't clear
      // the picker on role change — it only re-validates. We trim
      // multi-selections to a single ref when switching to ADMIN so
      // the wire format is correct.
      if (role === 'ADMIN' && prev.restaurantReference.length > 1) {
        return { ...prev, role, restaurantReference: prev.restaurantReference.slice(0, 1) }
      }
      return { ...prev, role }
    })
  }

  async function save() {
    if (!editing) return
    if (!editing.firstName.trim()) { setFormErr('First name required'); return }
    if (!editing.lastName.trim()) { setFormErr('Last name required'); return }
    if (!EMAIL_RE.test(editing.email.trim())) { setFormErr('Valid email required'); return }
    if (editing.restaurantReference.length === 0) {
      setFormErr(editing.role === 'SYSTEM_ADMIN' ? 'Pick at least one location' : 'Pick a location')
      return
    }
    setSaving(true); setFormErr(null)
    const isNew = !editing.reference
    const body = {
      firstName: editing.firstName.trim(),
      lastName: editing.lastName.trim(),
      email: editing.email.trim(),
      role: editing.role,
      // FM expects an array on the wire even for single-location ADMIN
      // (update-authorized-users.component.ts:78-84).
      restaurantReference: editing.restaurantReference,
    }
    try {
      const res = await fetch(
        isNew ? '/api/restaurant/authorized-users' : `/api/restaurant/authorized-users/${editing.reference}`,
        {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.error || `HTTP ${res.status}`)
      }
      setEditing(null)
      load()
    } catch (e) {
      setFormErr((e as Error).message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function resetPassword(u: AuthUser) {
    if (!confirm(`Send password reset email to ${u.email}?`)) return
    await fetch(`/api/restaurant/authorized-users/${u.reference}/reset-password`, { method: 'PUT' })
    alert('Password reset email sent.')
  }

  async function deleteUser(u: AuthUser) {
    // Mirrors FM ConfirmationDialogComponent copy.
    if (!confirm(`Delete ${u.firstName} ${u.lastName || ''}? All data of this user will be lost.`)) return
    await fetch(`/api/restaurant/authorized-users/${u.reference}`, { method: 'DELETE' })
    load()
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', letterSpacing: '0.04em' }
  const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Authorized Users</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="text" placeholder="Search by name…" value={search} onChange={e => { setPage(0); setSearch(e.target.value) }}
            style={{ ...input, width: 260 }} />
          <button onClick={openCreate}
            style={{ padding: '9px 18px', background: INDIGO, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
            + Add User
          </button>
        </div>
      </div>

      {/* SYSTEM_ADMIN-only: Team management (sub system admins + locations),
          folded in from the former standalone Team page. Hidden for ADMIN. */}
      {isSystemAdmin && <TeamManagement />}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={colHead}>Name</th>
            <th style={{ ...colHead, width: 140 }}>Role</th>
            <th style={colHead}>Email</th>
            <th style={{ ...colHead, width: 110 }}>Registration</th>
            <th style={{ ...colHead, width: 260, textAlign: 'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !users.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>No users.</td></tr>}
            {!loading && users.map(u => {
              const isLocked = !!u.locked
              const roleLabel = ROLE_DISPLAY[u.role] || u.role
              return (
                <tr key={u.reference}>
                  <td style={{ ...cell, fontWeight: 600 }}>{u.firstName} {u.lastName || ''}</td>
                  <td style={cell}>
                    <span style={{ background: '#f0f1ff', color: BLUE, padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>
                      {roleLabel}
                    </span>
                  </td>
                  <td style={{ ...cell, color: '#555' }}>{u.email}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(u.createdDate)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {!isLocked && (
                      <>
                        <button onClick={() => openEdit(u)} style={btnLink}>Edit</button>
                        <button onClick={() => resetPassword(u)} style={btnLink}>Reset Password</button>
                        <button onClick={() => deleteUser(u)} style={{ ...btnLink, color: '#E76F51' }}>Delete</button>
                      </>
                    )}
                    {isLocked && <span style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>Locked</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }}
            style={{ border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
      </div>

      {editing && (
        <div onClick={() => !saving && setEditing(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', maxWidth: 560, width: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', fontFamily: F }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: DARK }}>
              {editing.reference ? 'Update User' : 'Create User'}
            </h3>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 2 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={lbl}>First name*</label>
                  <input style={input} value={editing.firstName} maxLength={50}
                    onChange={e => setEditing(p => p ? { ...p, firstName: e.target.value } : p)} />
                </div>
                <div>
                  <label style={lbl}>Last name*</label>
                  <input style={input} value={editing.lastName} maxLength={50}
                    onChange={e => setEditing(p => p ? { ...p, lastName: e.target.value } : p)} />
                </div>
              </div>
              <div>
                <label style={lbl}>Email*</label>
                <input style={input} type="email" value={editing.email}
                  onChange={e => setEditing(p => p ? { ...p, email: e.target.value } : p)} />
              </div>
              <div>
                <label style={lbl}>Role*</label>
                <select style={input} value={editing.role} onChange={e => changeRole(e.target.value as 'SYSTEM_ADMIN' | 'ADMIN')}>
                  {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>

              <div>
                <label style={lbl}>
                  {editing.role === 'SYSTEM_ADMIN' ? 'Assigned Locations' : 'Location'}*
                  <span style={{ color: '#999' }}> ({editing.restaurantReference.length})</span>
                </label>
                <input
                  type="text" placeholder="Filter locations…"
                  value={locationFilter} onChange={e => setLocationFilter(e.target.value)}
                  style={{ ...input, marginBottom: 8 }}
                />
                <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, maxHeight: 220, overflowY: 'auto', padding: 4, background: '#fff' }}>
                  {locationsLoading && (
                    <div style={{ padding: 14, fontSize: 12, color: '#888' }}>Loading locations…</div>
                  )}
                  {!locationsLoading && locations.length === 0 && (
                    <div style={{ padding: 14, fontSize: 12, color: '#999' }}>No locations available.</div>
                  )}
                  {locations
                    .filter(loc => !locationFilter || loc.businessName.toLowerCase().includes(locationFilter.toLowerCase()))
                    .map(loc => {
                      const checked = editing.restaurantReference.includes(loc.reference)
                      const disabled = loc.editable === false
                      const isMulti = editing.role === 'SYSTEM_ADMIN'
                      return (
                        <label key={loc.reference}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6,
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            fontSize: 13, color: disabled ? '#aaa' : DARK,
                            background: checked ? '#EEF0FD' : 'transparent',
                          }}>
                          <input
                            type={isMulti ? 'checkbox' : 'radio'}
                            name={isMulti ? undefined : 'admin-location'}
                            checked={checked}
                            disabled={disabled}
                            onChange={() => !disabled && toggleLocation(loc.reference)}
                            style={{ accentColor: INDIGO }}
                          />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {loc.businessName}
                          </span>
                        </label>
                      )
                    })}
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  {editing.role === 'SYSTEM_ADMIN'
                    ? 'System Admins can manage multiple locations. Pick all that apply.'
                    : 'Restaurant Users belong to a single location.'}
                </div>
              </div>
            </div>

            {formErr && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginTop: 12, fontSize: 13, color: '#DC2626' }}>
                {formErr}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button onClick={() => setEditing(null)} disabled={saving}
                style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving}
                style={{ padding: '9px 20px', background: INDIGO, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, fontFamily: F }}>
                {saving ? 'Saving…' : (editing.reference ? 'Update User' : 'Create User')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const btnLink: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4, fontWeight: 600 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5 }

// ── Team management (SYSTEM_ADMIN only) ──────────────────────────────────────
// Folded in from the former standalone /restaurant/team page: the PSA's sub
// system admins and the locations they have access to. Backed by the existing
// /api/restaurant/team* endpoints.

interface TmLocation { reference: string; name: string; address: string; isLive: boolean; isHome: boolean }
interface TmSubAdmin { email: string; firstName: string; lastName: string; pendingInvite?: boolean; locations: { reference: string; name: string }[] }

function TeamManagement() {
  const [locations, setLocations] = useState<TmLocation[]>([])
  const [subAdmins, setSubAdmins] = useState<TmSubAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TmSubAdmin | null>(null)
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', refs: [] as string[] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [resending, setResending] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/restaurant/team')
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
  function openEdit(s: TmSubAdmin) {
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

  async function removeSubAdmin(s: TmSubAdmin) {
    if (!confirm(`Remove system admin ${s.email}? This deletes their account and access.`)) return
    const res = await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(s.email)}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  async function resendInvite(s: TmSubAdmin) {
    setResending(s.email)
    const res = await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(s.email)}/resend-invite`, { method: 'POST' })
    setResending('')
    alert(res.ok ? `Invite resent to ${s.email}.` : 'Could not resend the invite.')
  }

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Section 1 — System Admins */}
      <section style={tmCard}>
        <div style={tmHead}>
          <h2 style={tmTitle}>System Admins</h2>
          <button onClick={openAdd} style={tmPrimaryBtn}>Invite System Admin</button>
        </div>
        {loading && <div style={{ color: '#999', fontSize: 13, padding: '8px 0' }}>Loading…</div>}
        {!loading && subAdmins.length === 0 && <div style={{ color: '#999', fontSize: 13, padding: '8px 0' }}>No system admins yet.</div>}
        {!loading && subAdmins.map(s => (
          <div key={s.email} style={tmRow}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>
                {`${s.firstName} ${s.lastName}`.trim() || s.email}
                <span style={s.pendingInvite ? tmPendingPill : tmActivePill}>{s.pendingInvite ? 'Pending' : 'Active'}</span>
              </div>
              <div style={{ fontSize: 12, color: '#888' }}>{s.email}</div>
              <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                {s.locations.length ? s.locations.map(l => l.name || l.reference).join(', ') : 'No locations'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              {s.pendingInvite && (
                <button onClick={() => resendInvite(s)} disabled={resending === s.email} style={tmLinkBtn}>
                  {resending === s.email ? 'Sending…' : 'Resend Invite'}
                </button>
              )}
              <button onClick={() => openEdit(s)} style={tmLinkBtn}>Edit</button>
              <button onClick={() => removeSubAdmin(s)} style={{ ...tmLinkBtn, color: '#E76F51' }}>Remove</button>
            </div>
          </div>
        ))}
      </section>

      {/* Section 2 — Your Locations */}
      <section style={{ ...tmCard, marginTop: 20 }}>
        <div style={tmHead}>
          <h2 style={tmTitle}>Your Locations</h2>
          <a href="/become-a-partner" style={{ ...tmPrimaryBtn, textDecoration: 'none', display: 'inline-block' }}>+ Add New Location</a>
        </div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
          Add another location through onboarding — your account will be linked automatically.
        </div>
        {loading && <div style={{ color: '#999', fontSize: 13, padding: '8px 0' }}>Loading…</div>}
        {!loading && locations.length === 0 && <div style={{ color: '#999', fontSize: 13, padding: '8px 0' }}>No locations yet.</div>}
        {!loading && locations.map(loc => (
          <div key={loc.reference} style={tmRow}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>
                {loc.name || loc.reference}
                {loc.isHome && <span style={tmHomePill}>Home</span>}
              </div>
              {loc.address && <div style={{ fontSize: 12, color: '#888' }}>{loc.address}</div>}
            </div>
            <span style={loc.isLive ? tmLivePill : tmOffPill}>{loc.isLive ? 'Live' : 'Not live'}</span>
          </div>
        ))}
      </section>

      {modalOpen && (
        <div style={tmOverlay} onClick={() => !saving && setModalOpen(false)}>
          <div style={tmModal} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: DARK }}>
              {editing ? 'Edit System Admin' : 'Invite System Admin'}
            </h3>
            {!editing && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                <input placeholder="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={tmInput} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <input placeholder="First name" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} style={tmInput} />
                  <input placeholder="Last name" value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} style={tmInput} />
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
              <button onClick={() => setModalOpen(false)} disabled={saving} style={tmSecondaryBtn}>Cancel</button>
              <button onClick={saveSubAdmin} disabled={saving} style={tmPrimaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const tmCard: React.CSSProperties = { background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '18px 20px' }
const tmHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }
const tmTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: DARK, margin: 0 }
const tmRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid #f0f0f0' }
const tmHomePill: React.CSSProperties = { marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#fff', background: BLUE, borderRadius: 6, padding: '2px 7px' }
const tmPendingPill: React.CSSProperties = { marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#92400E', background: '#FEF3C7', borderRadius: 6, padding: '2px 7px' }
const tmActivePill: React.CSSProperties = { marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#166534', background: '#DCFCE7', borderRadius: 6, padding: '2px 7px' }
const tmLivePill: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#166534', background: '#DCFCE7', borderRadius: 6, padding: '3px 9px', flexShrink: 0 }
const tmOffPill: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#92400E', background: '#FEF3C7', borderRadius: 6, padding: '3px 9px', flexShrink: 0 }
const tmPrimaryBtn: React.CSSProperties = { padding: '9px 16px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
const tmSecondaryBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }
const tmLinkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px' }
const tmOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
const tmModal: React.CSSProperties = { background: '#fff', borderRadius: 14, padding: '24px 28px', maxWidth: 520, width: '100%', maxHeight: '92vh', overflowY: 'auto', fontFamily: F }
const tmInput: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' }
