'use client'
import { useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'
const INDIGO = '#6466E8'
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
  const [deletePw, setDeletePw] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deleted, setDeleted] = useState(false)

  function openDelete() { setDeletePw(''); setDeleteError(''); setConfirmOpen(true) }
  function closeDelete() { if (!deleting && !deleted) { setConfirmOpen(false); setDeletePw(''); setDeleteError('') } }

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

  // Deletes the Disco account (server: app/api/auth/delete-account). Requires
  // the password. Every failure is shown in the dialog — it used to be
  // swallowed, leaving the dialog open with no explanation.
  async function deleteAccount(e?: React.FormEvent) {
    e?.preventDefault()
    setDeleteError('')
    if (!deletePw) { setDeleteError('Please enter your password to confirm.'); return }
    setDeleting(true)
    try {
      const res = await fetch('/api/auth/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: deletePw }),
        credentials: 'include',
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) {
        setDeleteError(data?.error || 'We couldn’t delete your account. Please try again.')
        setDeleting(false)
        return
      }
      setDeletePw('')
      setDeleted(true)
      setDeleting(false)
      // The server already deleted every session and cleared the httpOnly
      // cookies, so the diner is signed out. Clear the stored identity now, but
      // NOT via AuthContext.logout(): that nulls the user immediately, and the
      // account layout then redirects to /?login=1 (a sign-in prompt) before the
      // success message can be read. A full navigation home re-reads auth from
      // scratch and finds no session.
      try { localStorage.removeItem('currentUser'); localStorage.removeItem('disco_user') } catch {}
      setTimeout(() => { window.location.href = '/' }, 2500)
    } catch {
      setDeleteError('We couldn’t reach the server. Please check your connection and try again.')
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
        <button onClick={openDelete}
          style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: '#727272', textDecoration: 'underline', cursor: 'pointer', fontFamily: F }}>
          Delete account
        </button>
      </div>

      {/* Confirmation modal */}
      {confirmOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={closeDelete}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="delete-account-title"
            style={{ background: '#fff', borderRadius: 14, padding: '24px 26px', maxWidth: 420, width: '100%', fontFamily: F }}>
            {deleted ? (
              <div role="status">
                <div id="delete-account-title" style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 10 }}>Your account has been deleted</div>
                <p style={{ fontSize: 13, color: '#666', lineHeight: 1.6, margin: 0 }}>
                  You&apos;ve been signed out. Thanks for ordering with Disco Cater. Taking you to the home page…
                </p>
              </div>
            ) : (
              <form onSubmit={deleteAccount}>
                <div id="delete-account-title" style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 10 }}>Delete your account?</div>
                <p style={{ fontSize: 13, color: '#666', lineHeight: 1.6, margin: '0 0 12px' }}>
                  This can&apos;t be undone. Your profile, saved addresses, saved cards and favorites will be permanently deleted, and any recurring orders will be canceled. Receipts for orders you&apos;ve already placed are kept for the restaurant&apos;s records.
                </p>
                <label style={labelSt} htmlFor="delete-account-password">Enter your password to confirm</label>
                <input id="delete-account-password" className="acct-input" type="password" autoComplete="current-password"
                  value={deletePw} onChange={e => { setDeletePw(e.target.value); if (deleteError) setDeleteError('') }}
                  disabled={deleting} style={{ ...inputSt, marginBottom: 12 }} />
                {deleteError && (
                  <div role="alert" style={{ fontSize: 13, fontWeight: 600, color: RED, marginBottom: 12 }}>{deleteError}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                  <button type="button" onClick={closeDelete} disabled={deleting}
                    style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, color: DARK, cursor: deleting ? 'not-allowed' : 'pointer', fontFamily: F }}>
                    Cancel
                  </button>
                  <button type="submit" disabled={deleting || !deletePw}
                    style={{ background: RED, border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, color: '#fff', cursor: deleting || !deletePw ? 'not-allowed' : 'pointer', opacity: deleting || !deletePw ? 0.6 : 1, fontFamily: F }}>
                    {deleting ? 'Deleting…' : 'Delete my account'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
