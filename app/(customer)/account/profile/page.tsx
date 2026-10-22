'use client'
import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../context/AuthContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'
const INDIGO = '#6466E8'

const inputSt: React.CSSProperties = {
  width: '100%', padding: '10px 13px', border: '1px solid #e0e0e0',
  borderRadius: 8, fontSize: 14, fontFamily: F, color: DARK,
  outline: 'none', boxSizing: 'border-box', background: '#fff',
}
const labelSt: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6, fontFamily: F,
}

function Toast({ msg, type = 'success' }: { msg: string; type?: 'success' | 'error' }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: type === 'success' ? '#1D9E75' : '#E24B4A', color: '#fff', padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', fontFamily: F }}>
      {msg}
    </div>
  )
}

export default function ProfilePage() {
  const { user, refreshUser } = useAuthContext()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [company, setCompany] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  useEffect(() => {
    if (user && !loaded) {
      setFirstName(user.firstName || '')
      setLastName(user.lastName || '')
      setEmail(user.email || '')
      setPhone(user.phoneNumber || '')
      setCompany(user.companyName || '')
      setLoaded(true)
    }
  }, [user, loaded])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      // Saves to Disco's own customer record only (never FamilyMeal). Email is
      // the account key and is not editable here, so it is not sent.
      const res = await fetch('/api/fm-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, phoneNumber: phone, companyName: company }),
        credentials: 'include',
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        showToast(data?.error || 'Failed to save profile. Please try again.', 'error')
        return
      }
      // Show exactly what was stored (e.g. the phone normalised to digits).
      if (data) {
        setFirstName(data.firstName || '')
        setLastName(data.lastName || '')
        setPhone(data.phoneNumber || '')
        setCompany(data.companyName || '')
      }
      await refreshUser()
      showToast('Profile saved successfully')
    } catch {
      showToast('Failed to save profile. Please try again.', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .acct-input:focus { border-color: ${INDIGO} !important; box-shadow: 0 0 0 3px rgba(107,110,249,0.1) !important; }
      `}</style>
      <form onSubmit={save} style={{ maxWidth: 480, fontFamily: F }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 24, marginTop: 0 }}>Profile</h1>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={labelSt}>First name</label>
            <input className="acct-input" value={firstName} onChange={e => setFirstName(e.target.value)} style={inputSt} />
          </div>
          <div>
            <label style={labelSt}>Last name</label>
            <input className="acct-input" value={lastName} onChange={e => setLastName(e.target.value)} style={inputSt} />
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelSt}>Email address</label>
          <input className="acct-input" type="email" name="account-email" autoComplete="email" value={email} readOnly aria-readonly="true" style={{ ...inputSt, background: '#f6f6f8', color: '#777' }} />
          <div style={{ fontSize: 11, color: '#888', marginTop: 5 }}>Your email is your sign-in and can&apos;t be changed here. Contact support to change it.</div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelSt}>Phone number</label>
          <input className="acct-input" type="tel" name="account-phone" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. (555) 555-5555" style={inputSt} />
        </div>
        <div style={{ marginBottom: 24 }}>
          <label style={labelSt}>Company name (optional)</label>
          <input className="acct-input" value={company} onChange={e => setCompany(e.target.value)} placeholder="Company name (optional)" style={inputSt} />
        </div>
        <button
          type="submit"
          disabled={saving}
          style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </>
  )
}
