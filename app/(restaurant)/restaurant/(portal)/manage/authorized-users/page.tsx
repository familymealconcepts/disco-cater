'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast, confirmDialog } from '../../../../../components/ui/feedback'

// Authorized Users — restaurant portal. Two modes:
//   • Disco mode (PSA/SSA SYSTEM_ADMIN, Disco-native session): a single clean
//     table of the team they manage, backed by /api/restaurant/team*.
//   • FM mode (ADMIN role, or FM-native users like chef@familymeal.com): the
//     legacy FM-backed list + add/edit flow, unchanged.
// We pick the mode by probing /api/restaurant/team (200 → Disco, else → FM).

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const INDIGO = '#5B6FE8'
const PAGE_BG = '#F7F8FC'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const ROLE_DISPLAY: Record<string, string> = {
  SYSTEM_ADMIN: 'System Admin',
  ADMIN: 'Restaurant User',
  REGIONAL_ADMIN: 'Regional Admin',
}

function fmtDate(d?: string | null) {
  if (!d) return '—'
  try {
    const dt = new Date(d)
    if (isNaN(dt.getTime())) return '—'
    return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`
  } catch { return '—' }
}

// ── Shared styles ────────────────────────────────────────────────────────────
const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 16px', textAlign: 'left', background: '#FAFAFC', borderBottom: '1px solid #f0f0f0', letterSpacing: '0.04em' }
const cell: React.CSSProperties = { padding: '14px 16px', fontSize: 13, color: DARK, borderTop: '1px solid #f3f3f3', verticalAlign: 'middle' }
const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5 }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: INDIGO, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }
const secondaryBtn: React.CSSProperties = { padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }

function RolePill({ role }: { role: string }) {
  const label = ROLE_DISPLAY[role] || role
  const sa = role === 'SYSTEM_ADMIN'
  return (
    <span style={{ background: sa ? '#EEF0FF' : '#F3F4F6', color: sa ? BLUE : '#555', padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

// Small icon button (pencil / trash / envelope) — subtle, FM-style.
function IconBtn({ kind, title, onClick, disabled }: { kind: 'edit' | 'delete' | 'resend'; title: string; onClick: () => void; disabled?: boolean }) {
  const color = kind === 'delete' ? '#E53935' : '#6B7280'
  const paths: Record<string, React.ReactNode> = {
    edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
    delete: <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" /><path d="M10 11v6M14 11v6" /></>,
    resend: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m2 6 10 7 10-7" /></>,
  }
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={title}
      style={{ background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 6, lineHeight: 0, opacity: disabled ? 0.4 : 1 }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {paths[kind]}
      </svg>
    </button>
  )
}

export default function AuthorizedUsersPage() {
  const [mode, setMode] = useState<'loading' | 'disco' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    fetch('/api/restaurant/team')
      .then(r => { if (!cancelled) setMode(r.ok ? 'disco' : 'error') })
      .catch(() => { if (!cancelled) setMode('error') })
    return () => { cancelled = true }
  }, [])

  if (mode === 'loading') {
    return (
      <div className="dc-page-pad" style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 18px' }}>Authorized Users</h1>
        <div style={{ color: '#999', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }
  // There is no FamilyMeal mode any more: the team is Disco's for every session
  // and every change is saved to Disco only (Peter, 22 Oct 2026). The old
  // fallback created, edited and deleted users and their locations in
  // FamilyMeal. A failed load is shown as a failure, never as another system's list.
  if (mode === 'disco') return <DiscoUsers />
  return (
    <div className="dc-page-pad" style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 18px' }}>Authorized Users</h1>
      <div style={{ color: '#B3261E', fontSize: 13 }}>
        Could not load your team. <button onClick={() => window.location.reload()} style={{ background: 'none', border: 'none', color: BLUE, cursor: 'pointer', fontWeight: 600, fontFamily: F }}>Retry</button>
      </div>
    </div>
  )
}

// ── Disco mode (PSA / SSA) ───────────────────────────────────────────────────

interface TeamLocation { reference: string; name: string }
interface TeamUser {
  email: string; firstName: string; lastName: string; role: string
  registration: string | null; pendingInvite?: boolean; locations: TeamLocation[]
  /** Primary System Admin — only a Super Admin changes this. */
  isPrimary?: boolean
  /** Server's answer to "may I remove locations from this person": they are
   *  below me in the invite chain and not a Primary. The server re-checks. */
  canRemove?: boolean
}
interface TeamSelf {
  email: string; firstName: string; lastName: string; role: string
  registration: string | null; locations: TeamLocation[]
  isPrimary?: boolean
  canRemove?: boolean
}
interface TeamData { self: TeamSelf; users: TeamUser[]; locations: TeamLocation[] }

interface UserForm {
  email: string
  firstName: string
  lastName: string
  role: 'SYSTEM_ADMIN' | 'ADMIN'
  refs: string[]
  isEdit: boolean
  /** Locations they held when the dialog opened — the ones removal applies to. */
  original: string[]
  canRemove: boolean
}

function DiscoUsers() {
  const [data, setData] = useState<TeamData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [form, setForm] = useState<UserForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [busyEmail, setBusyEmail] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    // A failed request must NOT leave the previous roster on screen. `if (res.ok)
    // setData(...)` silently kept stale data — an incomplete team looked like a
    // complete one, which is the same class of bug as the swallowed scope
    // lookups on the server. Surface it instead.
    try {
      const res = await fetch('/api/restaurant/team')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setLoadErr(null)
    } catch (e) {
      setData(null)
      setLoadErr(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const locations = data?.locations || []

  // Rows: the logged-in user (greyed, no actions) first, then everyone they manage.
  const rows = useMemo(() => {
    if (!data) return [] as Array<TeamUser & { isSelf: boolean }>
    const self = { ...data.self, pendingInvite: false, isSelf: true }
    const others = (data.users || []).map(u => ({ ...u, isSelf: false }))
    return [self, ...others]
  }, [data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(u =>
      `${u.firstName} ${u.lastName}`.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
  }, [rows, search])

  function openAdd() {
    setFormErr(null)
    setForm({ email: '', firstName: '', lastName: '', role: 'ADMIN', refs: [], isEdit: false, original: [], canRemove: true })
  }
  function openEdit(u: TeamUser) {
    setFormErr(null)
    setForm({
      email: u.email, firstName: u.firstName, lastName: u.lastName,
      role: u.role === 'SYSTEM_ADMIN' ? 'SYSTEM_ADMIN' : 'ADMIN',
      refs: u.locations.map(l => l.reference), isEdit: true,
      original: u.locations.map(l => l.reference), canRemove: u.canRemove === true,
    })
  }
  function toggleRef(ref: string) {
    setForm(prev => {
      if (!prev) return prev
      // Removing a location someone already holds needs authority over them
      // (you invited them, or someone you invited did). Without it, their
      // existing locations stay fixed and you can only add.
      const locked = (r: string) => !prev.canRemove && prev.original.includes(r)
      if (prev.role === 'ADMIN') return prev.refs.some(locked) ? prev : { ...prev, refs: [ref] } // single-select
      const has = prev.refs.includes(ref)
      if (has && locked(ref)) return prev
      return { ...prev, refs: has ? prev.refs.filter(r => r !== ref) : [...prev.refs, ref] }
    })
  }
  function changeRole(role: 'SYSTEM_ADMIN' | 'ADMIN') {
    setForm(prev => {
      if (!prev) return prev
      // Trim to one location when switching to a single-location Restaurant User.
      if (role === 'ADMIN' && prev.refs.length > 1) return { ...prev, role, refs: prev.refs.slice(0, 1) }
      return { ...prev, role }
    })
  }

  async function save() {
    if (!form) return
    if (!form.isEdit) {
      if (!form.firstName.trim()) { setFormErr('First name required'); return }
      if (!form.lastName.trim()) { setFormErr('Last name required'); return }
      if (!EMAIL_RE.test(form.email.trim())) { setFormErr('Valid email required'); return }
    }
    if (form.refs.length === 0) { setFormErr(form.role === 'SYSTEM_ADMIN' ? 'Pick at least one location' : 'Pick a location'); return }
    setSaving(true); setFormErr(null)
    try {
      const res = form.isEdit
        ? await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(form.email)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restaurantReferences: form.refs }),
          })
        : await fetch('/api/restaurant/team/sub-admins', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: form.email.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim(),
              role: form.role, restaurantReferences: form.refs,
            }),
          })
      if (!res.ok) { const d = await res.json().catch(() => null); throw new Error(d?.error || `HTTP ${res.status}`) }
      setForm(null); load()
    } catch (e) {
      setFormErr((e as Error).message || 'Save failed')
    } finally { setSaving(false) }
  }

  async function deleteUser(u: TeamUser) {
    if (!(await confirmDialog(`Remove ${u.firstName} ${u.lastName} from your locations? Any locations they hold that you don't are kept; if none are left, their account is closed.`, { title: 'Remove user', confirmText: 'Remove', danger: true }))) return
    setBusyEmail(u.email)
    const res = await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(u.email)}`, { method: 'DELETE' })
    setBusyEmail('')
    const d = await res.json().catch(() => null)
    if (res.ok) {
      toast(d?.archived ? `${u.email} removed.` : `Removed your locations from ${u.email}; they keep ${d?.kept ?? 'their other'} location(s).`, { kind: 'success' })
      load()
    } else {
      toast(d?.error || 'Could not remove this user.', { kind: 'error' })
    }
  }
  async function resendInvite(u: TeamUser) {
    setBusyEmail(u.email)
    const res = await fetch(`/api/restaurant/team/sub-admins/${encodeURIComponent(u.email)}/resend-invite`, { method: 'POST' })
    setBusyEmail('')
    toast(res.ok ? `Invite resent to ${u.email}.` : 'Could not resend the invite.', { kind: res.ok ? 'success' : 'error' })
  }

  return (
    <div className="dc-page-pad" style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      {/* Wraps on narrow screens: a fixed 260px search box used to push
          "+ Add User" past the portal's overflow guard, out of reach. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginBottom: 18, gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Authorized Users</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: '0 1 auto', minWidth: 0, maxWidth: '100%' }}>
          <input type="text" placeholder="Search by name or email…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...input, width: 260, minWidth: 0, flex: '0 1 260px' }} />
          <button onClick={openAdd} style={primaryBtn}>+ Add User</button>
        </div>
      </div>

      {/* dc-xscroll: the table scrolls sideways inside this box on narrow
          screens instead of being clipped (portal layout style block). */}
      <div className="dc-xscroll" style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={colHead}>Name</th>
            <th style={{ ...colHead, width: 140 }}>Role</th>
            <th style={colHead}>Email</th>
            <th style={colHead}>Locations</th>
            <th style={{ ...colHead, width: 120 }}>Registration</th>
            <th style={{ ...colHead, width: 130, textAlign: 'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && loadErr && (
              <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#B3261E' }}>
                Could not load the team ({loadErr}). This list may be incomplete — reload rather than trusting it.
                <button onClick={() => load()} style={{ marginLeft: 10, background: 'none', border: 'none', color: BLUE, cursor: 'pointer', fontWeight: 600, fontFamily: F }}>Retry</button>
              </td></tr>
            )}
            {!loading && !loadErr && filtered.length === 0 && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>No users.</td></tr>}
            {!loading && !loadErr && filtered.map(u => {
              const locs = u.locations.map(l => l.name || l.reference).filter(Boolean).join(', ') || '—'
              const rowColor = u.isSelf ? '#aaa' : DARK
              return (
                <tr key={u.email} style={{ opacity: u.isSelf ? 0.6 : 1 }}>
                  <td style={{ ...cell, fontWeight: 600, color: rowColor }}>
                    {`${u.firstName} ${u.lastName}`.trim() || u.email}
                    {u.isSelf && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#999' }}>(You)</span>}
                    {!u.isSelf && u.pendingInvite && (
                      <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#92400E', background: '#FEF3C7', borderRadius: 6, padding: '2px 7px' }}>Invite pending</span>
                    )}
                  </td>
                  <td style={cell}><RolePill role={u.role} />{u.isPrimary && <span style={{ marginLeft: 6, background: '#FBEFFB', color: '#9C3AA3', padding: '3px 8px', borderRadius: 12, fontSize: 10.5, fontWeight: 700 }}>Primary</span>}</td>
                  <td style={{ ...cell, color: u.isSelf ? '#aaa' : '#555' }}>{u.email}</td>
                  <td style={{ ...cell, color: u.isSelf ? '#aaa' : '#555', maxWidth: 280 }}>{locs}</td>
                  <td style={{ ...cell, color: u.isSelf ? '#aaa' : '#666' }}>{fmtDate(u.registration)}</td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {u.isSelf ? (
                      <span style={{ fontSize: 11, color: '#bbb' }}>—</span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 2, justifyContent: 'flex-end' }}>
                        {u.pendingInvite && <IconBtn kind="resend" title="Resend invite" onClick={() => resendInvite(u)} disabled={busyEmail === u.email} />}
                        <IconBtn kind="edit" title="Edit" onClick={() => openEdit(u)} disabled={busyEmail === u.email} />
                        {u.canRemove && <IconBtn kind="delete" title="Remove" onClick={() => deleteUser(u)} disabled={busyEmail === u.email} />}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {form && (
        <div onClick={() => !saving && setForm(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', maxWidth: 520, width: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', fontFamily: F }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: DARK }}>{form.isEdit ? 'Edit User' : 'Add User'}</h3>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 2 }}>
              {!form.isEdit ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div><label style={lbl}>First name*</label>
                      <input style={input} maxLength={50} value={form.firstName} onChange={e => setForm(p => p ? { ...p, firstName: e.target.value } : p)} /></div>
                    <div><label style={lbl}>Last name*</label>
                      <input style={input} maxLength={50} value={form.lastName} onChange={e => setForm(p => p ? { ...p, lastName: e.target.value } : p)} /></div>
                  </div>
                  <div><label style={lbl}>Email*</label>
                    <input style={input} type="email" value={form.email} onChange={e => setForm(p => p ? { ...p, email: e.target.value } : p)} /></div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: '#555' }}>
                  <div style={{ fontWeight: 700, color: DARK }}>{`${form.firstName} ${form.lastName}`.trim()}</div>
                  <div>{form.email}</div>
                </div>
              )}

              <div>
                <label style={lbl}>Role*</label>
                <select style={input} value={form.role} disabled={form.isEdit}
                  onChange={e => changeRole(e.target.value as 'SYSTEM_ADMIN' | 'ADMIN')}>
                  <option value="ADMIN">Restaurant User</option>
                  <option value="SYSTEM_ADMIN">System Admin</option>
                </select>
              </div>

              <div>
                <label style={lbl}>
                  {form.role === 'SYSTEM_ADMIN' ? 'Locations' : 'Location'}*
                  <span style={{ color: '#999' }}> ({form.refs.length})</span>
                </label>
                <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, maxHeight: 220, overflowY: 'auto', padding: 4, background: '#fff' }}>
                  {locations.length === 0 && <div style={{ padding: 12, fontSize: 12, color: '#999' }}>You have no locations to assign.</div>}
                  {locations.map(loc => {
                    const checked = form.refs.includes(loc.reference)
                    const isMulti = form.role === 'SYSTEM_ADMIN'
                    const locked = !form.canRemove && form.original.includes(loc.reference)
                    return (
                      <label key={loc.reference} title={locked ? 'Only the person who invited them (or someone above) can remove this' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: locked ? 'not-allowed' : 'pointer', fontSize: 13, color: DARK, background: checked ? '#EEF0FD' : 'transparent', opacity: locked ? 0.7 : 1 }}>
                        <input type={isMulti ? 'checkbox' : 'radio'} name={isMulti ? undefined : 'disco-loc'} checked={checked} disabled={locked}
                          onChange={() => toggleRef(loc.reference)} style={{ accentColor: INDIGO }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc.name || loc.reference}</span>
                      </label>
                    )
                  })}
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  {form.role === 'SYSTEM_ADMIN' ? 'System Admins can manage multiple locations. You can assign only locations you have.' : 'Restaurant Users belong to a single location.'}
                  {form.isEdit && !form.canRemove && ' You can add locations, but not remove any — you didn’t invite this person.'}
                </div>
              </div>
            </div>

            {formErr && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginTop: 12, fontSize: 13, color: '#DC2626' }}>{formErr}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button onClick={() => setForm(null)} disabled={saving} style={secondaryBtn}>Cancel</button>
              <button onClick={save} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : (form.isEdit ? 'Save' : 'Send Invite')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
