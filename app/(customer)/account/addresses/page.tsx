'use client'
import { useState, useEffect, useRef } from 'react'

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

interface SavedAddress {
  id: string
  address_line1: string
  address_line2: string | null
  city: string
  state: string
  zipcode: string
  latitude: number | null
  longitude: number | null
  delivery_instructions: string | null
  is_default: boolean
}

interface AddrParts {
  addressLine1: string; city: string; state: string; zipcode: string
  latitude: number | null; longitude: number | null
}

// Parse a Google Places result into our address fields.
function extractPlace(place: any): AddrParts {
  const c = place.address_components ?? []
  const get = (type: string, short = false) => {
    const comp = c.find((x: any) => x.types?.includes(type))
    return comp ? (short ? comp.short_name : comp.long_name) : ''
  }
  const streetNum = get('street_number')
  const route = get('route')
  const city = get('locality') || get('sublocality') || get('postal_town') || get('administrative_area_level_2')
  const state = get('administrative_area_level_1', true)
  const zipcode = get('postal_code')
  const lat = place.geometry?.location?.lat?.() ?? null
  const lng = place.geometry?.location?.lng?.() ?? null
  return { addressLine1: [streetNum, route].filter(Boolean).join(' '), city, state, zipcode, latitude: lat, longitude: lng }
}

export default function AddressesPage() {
  const [addresses, setAddresses] = useState<SavedAddress[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)

  // New-address form state
  const [parts, setParts] = useState<AddrParts | null>(null)
  const [line1Text, setLine1Text] = useState('')
  const [line2, setLine2] = useState('')
  const [instructions, setInstructions] = useState('')
  const [formErr, setFormErr] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  // The exact formatted address last chosen from the Places dropdown. Lets the
  // input's onChange tell Google's programmatic fill (keep `parts`) apart from a
  // real user edit (invalidate `parts`). Fixes the race where the post-selection
  // `input` event fired AFTER `place_changed` and nulled `parts`, blocking Save.
  const selectedAddrRef = useRef('')
  const [placesLoaded, setPlacesLoaded] = useState(false)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/customer-addresses', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        setAddresses(Array.isArray(d.addresses) ? d.addresses : [])
      }
    } catch { /* surfaced via empty state */ } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  // Load Google Places once, lazily — only needed for the add form.
  useEffect(() => {
    if (!adding) return
    if ((window as any).google?.maps?.places) { setPlacesLoaded(true); return }
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    if (!key) return
    const existing = document.querySelector('script[data-google-places]')
    if (existing) { existing.addEventListener('load', () => setPlacesLoaded(true)); return }
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`
    script.async = true
    script.setAttribute('data-google-places', 'true')
    script.onload = () => setPlacesLoaded(true)
    document.head.appendChild(script)
  }, [adding])

  // Wire the autocomplete to the address input when the form is open.
  useEffect(() => {
    if (!adding || !placesLoaded || !inputRef.current) return
    const google = (window as any).google
    if (!google?.maps?.places) return
    const ac = new google.maps.places.Autocomplete(inputRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['address_components', 'geometry', 'formatted_address'],
    })
    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace()
      if (!place?.address_components) return
      const formatted = place.formatted_address ?? ''
      // Record the selection BEFORE updating state so the (possibly later)
      // programmatic `input` event onChange recognizes it and keeps `parts`.
      selectedAddrRef.current = formatted
      setParts(extractPlace(place))
      setLine1Text(formatted)
      setFormErr('')
    })
    return () => { google.maps.event.removeListener(listener) }
  }, [adding, placesLoaded])

  function resetForm() {
    selectedAddrRef.current = ''
    setParts(null); setLine1Text(''); setLine2(''); setInstructions(''); setFormErr('')
  }

  async function saveAddress(e: React.FormEvent) {
    e.preventDefault()
    if (!parts || !parts.addressLine1 || !parts.city || !parts.state || !parts.zipcode) {
      setFormErr('Please pick an address from the suggestions so we can verify it.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/customer-addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          addressLine1: parts.addressLine1, addressLine2: line2,
          city: parts.city, state: parts.state, zipcode: parts.zipcode,
          latitude: parts.latitude, longitude: parts.longitude,
          deliveryInstructions: instructions,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.error || 'Failed to save')
      }
      showToast('Address added')
      resetForm(); setAdding(false)
      await load()
    } catch (err: any) {
      setFormErr(err?.message || 'Failed to save address')
    } finally {
      setSaving(false)
    }
  }

  async function setDefault(id: string) {
    // Optimistic — flip the default locally, then persist.
    setAddresses(prev => prev.map(a => ({ ...a, is_default: a.id === id })))
    try {
      const res = await fetch(`/api/customer-addresses/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ isDefault: true }),
      })
      if (!res.ok) throw new Error()
      showToast('Default address updated')
    } catch {
      showToast('Could not update default', 'error')
      load()
    }
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/customer-addresses/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error()
      showToast('Address removed')
      await load()
    } catch {
      showToast('Could not remove address', 'error')
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .acct-input:focus { border-color: ${INDIGO} !important; box-shadow: 0 0 0 3px rgba(107,110,249,0.1) !important; }
        .pac-container { z-index: 1100 !important; font-family: ${F}; }
      `}</style>
      <div style={{ maxWidth: 560, fontFamily: F }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 8, marginTop: 0 }}>Addresses</h1>
        <p style={{ fontSize: 13, color: '#727272', margin: '0 0 24px', lineHeight: 1.5 }}>
          Save delivery addresses and pick a default — it&apos;ll be pre-selected at checkout.
        </p>

        {loading ? (
          <div style={{ color: '#727272', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {addresses.length === 0 && !adding && (
              <div style={{ border: '1px dashed #ddd', borderRadius: 12, padding: '28px 20px', textAlign: 'center', color: '#727272', fontSize: 13, marginBottom: 16 }}>
                You don&apos;t have any saved addresses yet.
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
              {addresses.map(a => (
                <div key={a.id} style={{ border: `1.5px solid ${a.is_default ? INDIGO : '#ececec'}`, borderRadius: 12, padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start', background: a.is_default ? 'rgba(107,110,249,0.04)' : '#fff' }}>
                  <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', paddingTop: 2 }}>
                    <input
                      type="radio"
                      name="default-address"
                      checked={a.is_default}
                      onChange={() => setDefault(a.id)}
                      style={{ accentColor: INDIGO, width: 16, height: 16, cursor: 'pointer' }}
                    />
                  </label>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>
                      {a.address_line1}{a.address_line2 ? `, ${a.address_line2}` : ''}
                      {a.is_default && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: INDIGO, background: 'rgba(107,110,249,0.12)', padding: '2px 8px', borderRadius: 999 }}>Default</span>}
                    </div>
                    <div style={{ fontSize: 13, color: '#727272', marginTop: 2 }}>
                      {[a.city, a.state].filter(Boolean).join(', ')} {a.zipcode}
                    </div>
                    {a.delivery_instructions && (
                      <div style={{ fontSize: 12, color: '#727272', marginTop: 4 }}>📝 {a.delivery_instructions}</div>
                    )}
                    <div style={{ marginTop: 8, display: 'flex', gap: 14 }}>
                      {!a.is_default && (
                        <button onClick={() => setDefault(a.id)} style={{ background: 'none', border: 'none', color: INDIGO, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: F }}>Set as default</button>
                      )}
                      <button onClick={() => remove(a.id)} style={{ background: 'none', border: 'none', color: '#C0392B', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: F }}>Remove</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {adding ? (
              <form onSubmit={saveAddress} style={{ border: '1px solid #ececec', borderRadius: 12, padding: 18 }}>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelSt}>Street address</label>
                  <input
                    ref={inputRef}
                    className="acct-input"
                    value={line1Text}
                    onChange={e => {
                      const v = e.target.value
                      setLine1Text(v)
                      // Only invalidate verification on a genuine user edit — NOT
                      // Google's programmatic fill (which equals the selection).
                      if (v !== selectedAddrRef.current) setParts(null)
                    }}
                    placeholder="Start typing your address…"
                    style={inputSt}
                    autoComplete="off"
                  />
                  <div style={{ fontSize: 11, color: '#727272', marginTop: 5 }}>Pick a suggestion so we can verify and geocode the address.</div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelSt}>Apt, suite, floor (optional)</label>
                  <input className="acct-input" value={line2} onChange={e => setLine2(e.target.value)} style={inputSt} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelSt}>Delivery instructions (optional)</label>
                  <textarea
                    className="acct-input"
                    value={instructions}
                    onChange={e => setInstructions(e.target.value)}
                    placeholder="e.g. Leave at front desk, call on arrival…"
                    rows={2}
                    style={{ ...inputSt, resize: 'vertical' }}
                  />
                </div>
                {formErr && <div style={{ fontSize: 12, color: '#E24B4A', marginBottom: 14 }}>{formErr}</div>}
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="submit" disabled={saving} style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}>
                    {saving ? 'Saving…' : 'Save address'}
                  </button>
                  <button type="button" onClick={() => { setAdding(false); resetForm() }} style={{ background: 'none', color: '#727272', border: '1px solid #e0e0e0', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button onClick={() => setAdding(true)} style={{ background: 'none', color: INDIGO, border: `1.5px dashed ${INDIGO}`, borderRadius: 10, padding: '11px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, width: '100%' }}>
                + Add address
              </button>
            )}
          </>
        )}
      </div>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </>
  )
}
