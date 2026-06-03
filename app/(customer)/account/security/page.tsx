'use client'
import { useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const RED = '#E24B4A'

const inputSt: React.CSSProperties = {
  width: '100%', padding: '10px 13px', border: '1px solid #e0e0e0',
  borderRadius: 8, fontSize: 14, fontFamily: F, color: DARK,
  outline: 'none', boxSizing: 'border-box', background: '#fff',
}
const labelSt: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6, fontFamily: F,
}

export default function SecurityPage() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwMsg(null)
    if (!current || !next) { setPwMsg({ text: 'Please fill in all fields.', type: 'error' }); return }
    if (next.length < 8) { setPwMsg({ text: 'New password must be at least 8 characters.', type: 'error' }); return }
    if (next !== confirm) { setPwMsg({ text: 'New passwords do not match.', type: 'error' }); return }
    setSaving(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
        credentials: 'include',
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) { setPwMsg({ text: data?.error || 'Could not update password.', type: 'error' }); return }
      setPwMsg({ text: 'Password updated successfully', type: 'success' })
      setCurrent(''); setNext(''); setConfirm('')
    } catch {
      setPwMsg({ text: 'Could not update password. Please try again.', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function deleteAccount() {
    setDeleting(true)
    try {
      const res = await fetch('/api/auth/delete-account', { method: 'POST', credentials: 'include' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) { setDeleting(false); return }
      try { localStorage.removeItem('currentUser'); localStorage.removeItem('disco_user') } catch {}
      // Best-effort cookie clear (httpOnly cookies are cleared server-side).
      try { document.cookie.split(';').forEach(c => { document.cookie = c.replace(/^ +/, '').replace(/=.*/, `=;expires=${new Date(0).toUTCString()};path=/`) }) } catch {}
      window.location.href = '/'
    } catch {
      setDeleting(false)
    }
  }

  return (
    <div style={{ fontFamily: F, maxWidth: 480 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .acct-input:focus { border-color: ${INDIGO} !important; box-shadow: 0 0 0 3px rgba(107,110,249,0.1) !important; }
      `}</style>

      <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 24, marginTop: 0 }}>Security</h1>

      {/* ── Change Password ── */}
      <form onSubmit={changePassword} style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '20px 22px', background: '#fff', marginBottom: 28 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 16 }}>Change password</div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelSt}>Current password</label>
          <input className="acct-input" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} style={inputSt} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelSt}>New password</label>
          <input className="acct-input" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} placeholder="At least 8 characters" style={inputSt} />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={labelSt}>Confirm new password</label>
          <input className="acct-input" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} style={inputSt} />
        </div>
        {pwMsg && (
          <div style={{ fontSize: 13, fontWeight: 600, color: pwMsg.type === 'success' ? '#1D9E75' : RED, marginBottom: 14 }}>
            {pwMsg.text}
          </div>
        )}
        <button type="submit" disabled={saving}
          style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}>
          {saving ? 'Updating…' : 'Update password'}
        </button>
      </form>

      {/* ── Delete Account (subtle, bottom of page) ── */}
      <div style={{ marginTop: 8 }}>
        <button onClick={() => setConfirmOpen(true)}
          style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: '#aaa', textDecoration: 'underline', cursor: 'pointer', fontFamily: F }}>
          Delete account
        </button>
      </div>

      {/* Confirmation modal */}
      {confirmOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => !deleting && setConfirmOpen(false)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '24px 26px', maxWidth: 420, width: '100%', fontFamily: F }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 10 }}>Are you sure?</div>
            <p style={{ fontSize: 13, color: '#666', lineHeight: 1.6, margin: '0 0 22px' }}>
              This action cannot be undone. Your account and all associated data will be permanently deleted.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setConfirmOpen(false)} disabled={deleting}
                style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, color: DARK, cursor: deleting ? 'not-allowed' : 'pointer', fontFamily: F }}>
                Cancel
              </button>
              <button onClick={deleteAccount} disabled={deleting}
                style={{ background: RED, border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, color: '#fff', cursor: deleting ? 'not-allowed' : 'pointer', fontFamily: F }}>
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
