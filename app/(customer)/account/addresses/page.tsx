'use client'
import { useState, useEffect } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'

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

interface FmAddress {
  addressLine1?: string
  city?: string
  state?: string
  zipcode?: string
}

export default function AddressesPage() {
  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // AuthContext's `user.address` typing is a stale single-string remnant —
  // FM actually returns a structured { addressLine1, city, state, zipcode }
  // off /api/fm-user. Pull it directly so all four fields pre-fill.
  useEffect(() => {
    let cancelled = false
    fetch('/api/fm-user', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        const addr: FmAddress | null = d?.address || null
        if (addr) {
          if (addr.addressLine1) setLine1(addr.addressLine1)
          if (addr.city) setCity(addr.city)
          if (addr.state) setState(addr.state)
          if (addr.zipcode) setZip(addr.zipcode)
        } else if (typeof d?.address === 'string') {
          // Some FM payloads still flatten address into a single string.
          setLine1(d.address)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/fm-user-addresses', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addressLine1: line1, city, state, zipcode: zip }),
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to save')
      showToast('Address saved')
    } catch {
      showToast('Failed to save address', 'error')
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
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 8, marginTop: 0 }}>Addresses</h1>
        <p style={{ fontSize: 13, color: '#888', margin: '0 0 24px', lineHeight: 1.5 }}>
          This is your default delivery address and will be pre-filled at checkout.
        </p>
        <div style={{ marginBottom: 14 }}>
          <label style={labelSt}>Street address</label>
          <input className="acct-input" value={line1} onChange={e => setLine1(e.target.value)} placeholder="123 Main St" style={inputSt} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 24 }}>
          <div>
            <label style={labelSt}>City</label>
            <input className="acct-input" value={city} onChange={e => setCity(e.target.value)} placeholder="New York" style={inputSt} />
          </div>
          <div>
            <label style={labelSt}>State</label>
            <input className="acct-input" value={state} onChange={e => setState(e.target.value)} placeholder="NY" style={inputSt} />
          </div>
          <div>
            <label style={labelSt}>Zip</label>
            <input className="acct-input" value={zip} onChange={e => setZip(e.target.value)} placeholder="10001" style={inputSt} />
          </div>
        </div>
        <button
          type="submit"
          disabled={saving}
          style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}
        >
          {saving ? 'Saving…' : 'Save address'}
        </button>
      </form>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </>
  )
}
