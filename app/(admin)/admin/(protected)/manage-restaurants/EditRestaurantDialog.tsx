'use client'
import { useEffect, useRef, useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const GRADIENT = 'linear-gradient(90deg, #6B6EF9, #C044C8, #F0468A)'

// Image picker with explicit Upload / Change / Remove buttons + a sizing hint.
function ImageField({ label, currentSet, file, onChange }: {
  label: string; currentSet?: boolean; file: File | null; onChange: (f: File | null) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }
  const btn: React.CSSProperties = { background: '#EEF0FD', border: '1.5px solid #c8cafd', color: '#3A3DB0', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }
  const ghost: React.CSSProperties = { background: '#fff', border: '1.5px solid #e0e0e0', color: '#777', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F }
  return (
    <div>
      <label style={lbl}>{label}{currentSet ? ' (current set)' : ''}</label>
      <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => onChange(e.target.files?.[0] || null)} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => ref.current?.click()} style={btn}>
          {file ? 'Change image' : 'Upload image'}
        </button>
        {file && (
          <button type="button" onClick={() => { onChange(null); if (ref.current) ref.current.value = '' }} style={ghost}>
            Remove image
          </button>
        )}
        {file && <span style={{ fontSize: 12, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{file.name}</span>}
      </div>
      <p style={{ fontSize: 11, color: '#aaa', margin: '6px 0 0' }}>Recommended: square image, min 400×400px</p>
    </div>
  )
}

// Cuisine options — must match the Sanity restaurant schema `cuisines` array
// field exactly (sanity/schema/restaurant.ts). Max 3 selections.
const CUISINES = ['BBQ', 'Bagels', 'Bakery', 'Bar & Grill', 'Breakfast', 'Burgers', 'Cafe', 'Caribbean', 'Chicken', 'Deli', 'Chinese', 'French', 'Greek', 'Indian', 'Italian', 'Japanese', 'Korean', 'Latin', 'Mediterranean', 'Mexican', 'Middle Eastern', 'Pizza', 'Sandwiches', 'Seafood', 'Soul Food', 'Thai', 'Vegan', 'Vietnamese']
const MAX_CUISINES = 3

interface FmAddress { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zipcode?: string; phoneNumber?: string; latitude?: number; longitude?: number }
interface FmRestaurant {
  reference: string
  businessName?: string
  businessNameWithoutSpaces?: string
  address?: FmAddress
  admin?: { firstName?: string; lastName?: string; email?: string }
  categories?: string[]
  fulfillmentOptions?: string[]
  timezone?: string
  leadGenOne?: number
  leadGenTwo?: number
  image?: { reference?: string }
  marketplaceImage?: { image?: { reference?: string } }
}

interface SanityMarketplace {
  _id?: string
  cuisines?: string[]
  description?: string
  location?: string
  lat?: number
  lng?: number
  orderUrl?: string
  isDisco?: boolean
  image?: { asset?: { _ref?: string } }
}

interface Props {
  restaurantRef: string
  onClose: () => void
  onSaved: (msg: string) => void
}

function pctOrDefault(raw: string, fallback: number): number {
  const n = parseFloat(raw)
  if (!isFinite(n)) return fallback
  return Math.min(100, Math.max(0, n))
}

export default function EditRestaurantDialog({ restaurantRef, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [existing, setExisting] = useState<FmRestaurant | null>(null)

  // FM fields
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [restaurantName, setRestaurantName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [addr1, setAddr1] = useState('')
  const [addr2, setAddr2] = useState('')
  const [city, setCity] = useState('')
  const [stateVal, setStateVal] = useState('')
  const [zipcode, setZipcode] = useState('')
  const [leadGenOne, setLeadGenOne] = useState('15')
  const [leadGenTwo, setLeadGenTwo] = useState('5')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [marketImageFile, setMarketImageFile] = useState<File | null>(null)

  // Marketplace (Sanity)
  const [mpOpen, setMpOpen] = useState(false)
  const [mpExists, setMpExists] = useState<boolean | null>(null)
  const [cuisines, setCuisines] = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [orderUrl, setOrderUrl] = useState('')
  // Premium (isDisco) + order-URL override now live in Neon
  // (disco_restaurant_overrides), read by the public fullmap. Loaded/saved via
  // /api/admin/restaurant-overrides — independent of the Sanity marketplace doc.
  const [isDisco, setIsDisco] = useState(false)
  const [orderUrlOverride, setOrderUrlOverride] = useState('')
  // Hero image: hidden from the form. The submit() upload branch + backend
  // marketplace-image route are kept intact; heroFile simply stays null now that
  // the input is removed, so the branch is dormant (no setter to avoid lint).
  const [heroFile] = useState<File | null>(null)

  // Google Places description fetch.
  const [fetchingDesc, setFetchingDesc] = useState(false)
  const [descError, setDescError] = useState('')

  async function fetchGoogleDescription() {
    setDescError('')
    setFetchingDesc(true)
    try {
      const address = [addr1, city, stateVal, zipcode].map(s => s.trim()).filter(Boolean).join(', ')
      const params = new URLSearchParams({ name: restaurantName.trim(), address })
      const res = await fetch(`/api/admin/places-description?${params}`)
      const data = await res.json().catch(() => null)
      if (res.ok && data?.description) {
        setDescription(String(data.description).slice(0, 500))
      } else {
        setDescError(data?.error || 'No description found on Google Places')
      }
    } catch {
      setDescError('No description found on Google Places')
    } finally {
      setFetchingDesc(false)
    }
  }

  useEffect(() => {
    let cancel = false
    setLoading(true); setErr('')
    Promise.all([
      fetch(`/api/admin/restaurants/${restaurantRef}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/admin/restaurant-marketplace?fmReference=${restaurantRef}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/admin/restaurant-overrides?restaurantReference=${restaurantRef}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([fm, mp, ov]: [FmRestaurant | null, SanityMarketplace | null, { isPremium?: boolean; orderUrl?: string } | null]) => {
      if (cancel) return
      if (fm) {
        setExisting(fm)
        setFirstName(fm.admin?.firstName || '')
        setLastName(fm.admin?.lastName || '')
        setRestaurantName(fm.businessName || '')
        setEmail(fm.admin?.email || '')
        setPhone(fm.address?.phoneNumber || '')
        setAddr1(fm.address?.addressLine1 || '')
        setAddr2(fm.address?.addressLine2 || '')
        setCity(fm.address?.city || '')
        setStateVal(fm.address?.state || '')
        setZipcode(fm.address?.zipcode || '')
        setLeadGenOne(fm.leadGenOne != null ? String(fm.leadGenOne) : '15')
        setLeadGenTwo(fm.leadGenTwo != null ? String(fm.leadGenTwo) : '5')
      }
      setMpExists(!!mp)
      if (mp) {
        setCuisines(mp.cuisines || [])
        setDescription(mp.description || '')
        setLocation(mp.location || '')
        setLat(mp.lat != null ? String(mp.lat) : '')
        setLng(mp.lng != null ? String(mp.lng) : '')
        setOrderUrl(mp.orderUrl || '')
      }
      // Premium + order-URL override come from Neon (source of truth for fullmap).
      if (ov) {
        setIsDisco(!!ov.isPremium)
        setOrderUrlOverride(ov.orderUrl || '')
      }
    }).catch(() => { if (!cancel) setErr('Failed to load restaurant') })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [restaurantRef])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Multi-select cuisines, capped at MAX_CUISINES (mirrors the Sanity
  // validation Rule.max(3) on the cuisines array).
  function toggleCuisine(c: string) {
    setCuisines(s => s.includes(c) ? s.filter(x => x !== c) : (s.length >= MAX_CUISINES ? s : [...s, c]))
  }

  async function submit() {
    setErr('')
    if (!firstName.trim() || !lastName.trim()) return setErr('First and last name are required')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr('Valid email is required')
    if (!phone.trim()) return setErr('Phone is required')
    if (!addr1.trim()) return setErr('Address line 1 is required')

    setSaving(true)
    try {
      // Preserve FM fields the dialog doesn't edit (categories, fulfillment,
      // timezone, lat/lng) so the PUT doesn't clear them. Mirrors FM's
      // add-restaurant payload shape (admin/restaurant/update/add-restaurant).
      const payload = {
        address: {
          addressLine1: addr1.trim(),
          addressLine2: addr2.trim() || undefined,
          city: city.trim(),
          state: stateVal.trim().toUpperCase(),
          zipcode: zipcode.trim(),
          phoneNumber: phone.trim(),
          latitude: existing?.address?.latitude,
          longitude: existing?.address?.longitude,
        },
        businessName: restaurantName.trim(),
        categories: existing?.categories,
        admin: { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() },
        timezone: existing?.timezone,
        fulfillmentOptions: existing?.fulfillmentOptions,
        leadGenOne: pctOrDefault(leadGenOne, 15),
        leadGenTwo: pctOrDefault(leadGenTwo, 5),
      }
      const putRes = await fetch(`/api/admin/restaurants/${restaurantRef}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!putRes.ok) throw new Error('Failed to save restaurant')

      // Premium flag + order-URL override → Neon (drives the public fullmap).
      const ovRes = await fetch('/api/admin/restaurant-overrides', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantReference: restaurantRef, isPremium: isDisco, orderUrl: orderUrlOverride || undefined }),
      })
      if (!ovRes.ok) throw new Error('Saved restaurant, but the Premium / order-URL override failed to save')

      if (logoFile) {
        const fd = new FormData(); fd.append('file', logoFile)
        await fetch(`/api/admin/restaurants/${restaurantRef}/logo`, { method: 'POST', body: fd })
      }
      if (marketImageFile) {
        const fd = new FormData(); fd.append('file', marketImageFile)
        await fetch(`/api/admin/restaurants/${restaurantRef}/marketplace-image`, { method: 'POST', body: fd })
      }

      // Marketplace (Sanity). Only write when the section was opened/touched.
      if (mpOpen) {
        let imageField: unknown = undefined
        if (heroFile) {
          const fd = new FormData(); fd.append('file', heroFile)
          const imgRes = await fetch('/api/admin/restaurant-marketplace/image', { method: 'POST', body: fd })
          if (imgRes.ok) { const d = await imgRes.json(); imageField = d.image }
        }
        const mpBody: Record<string, unknown> = {
          fmReference: restaurantRef,
          name: restaurantName.trim(),
          cuisines,
          description: description || undefined,
          location: location || undefined,
          lat: lat === '' ? undefined : Number(lat),
          lng: lng === '' ? undefined : Number(lng),
          orderUrl: orderUrl || undefined,
        }
        if (imageField) mpBody.image = imageField
        const mpRes = await fetch('/api/admin/restaurant-marketplace', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mpBody),
        })
        if (!mpRes.ok) {
          const d = await mpRes.json().catch(() => null)
          throw new Error(d?.error || 'Saved restaurant data, but the Marketplace (Sanity) write failed')
        }
      }

      onSaved('Restaurant updated')
    } catch (e) {
      setErr((e as Error).message || 'Unable to save')
    } finally {
      setSaving(false)
    }
  }

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 5 }
  const input: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', boxSizing: 'border-box' }
  const section: React.CSSProperties = { border: '1px solid #eee', borderRadius: 12, padding: '18px 20px', background: '#fff', marginBottom: 14 }
  const sTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: DARK, marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.04em' }
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.45)', zIndex: 1100, display: 'flex', justifyContent: 'flex-end', fontFamily: F }}>
      <div style={{ width: '100%', maxWidth: 640, background: '#f7f7fb', height: '100vh', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 28px rgba(0,0,0,0.16)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 22px', borderBottom: '1px solid #ececf2', background: '#fff', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 11, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Edit Restaurant</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginTop: 2 }}>{restaurantName || '…'}</div>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 34, height: 34, borderRadius: '50%', fontSize: 18, color: '#555' }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          {loading ? (
            <div style={{ color: '#aaa', fontSize: 13, textAlign: 'center', padding: '60px 0' }}>Loading…</div>
          ) : (
            <>
              {err && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#DC2626', fontWeight: 500 }}>{err}</div>}

              {/* Admin + restaurant */}
              <div style={section}>
                <div style={sTitle}>Restaurant &amp; admin</div>
                <div style={grid2}>
                  <div><label style={label}>First name *</label><input style={input} value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
                  <div><label style={label}>Last name *</label><input style={input} value={lastName} onChange={e => setLastName(e.target.value)} /></div>
                </div>
                <div style={{ marginBottom: 12 }}><label style={label}>Restaurant name</label><input style={input} value={restaurantName} onChange={e => setRestaurantName(e.target.value)} /></div>
                <div style={grid2}>
                  <div><label style={label}>Email *</label><input style={input} value={email} onChange={e => setEmail(e.target.value)} /></div>
                  <div><label style={label}>Phone *</label><input style={input} value={phone} onChange={e => setPhone(e.target.value)} /></div>
                </div>
              </div>

              {/* Address */}
              <div style={section}>
                <div style={sTitle}>Address</div>
                <div style={{ marginBottom: 12 }}><label style={label}>Address line 1 *</label><input style={input} value={addr1} onChange={e => setAddr1(e.target.value)} /></div>
                <div style={{ marginBottom: 12 }}><label style={label}>Address line 2</label><input style={input} value={addr2} onChange={e => setAddr2(e.target.value)} /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
                  <div><label style={label}>City</label><input style={input} value={city} onChange={e => setCity(e.target.value)} /></div>
                  <div><label style={label}>State</label><input style={input} value={stateVal} onChange={e => setStateVal(e.target.value)} maxLength={2} /></div>
                  <div><label style={label}>Zip</label><input style={input} value={zipcode} onChange={e => setZipcode(e.target.value)} /></div>
                </div>
              </div>

              {/* Images */}
              <div style={section}>
                <div style={sTitle}>Images</div>
                <div style={grid2}>
                  <ImageField label="Restaurant logo" currentSet={!!existing?.image?.reference} file={logoFile} onChange={setLogoFile} />
                  <ImageField label="Marketplace image" currentSet={!!existing?.marketplaceImage?.image?.reference} file={marketImageFile} onChange={setMarketImageFile} />
                </div>
              </div>

              {/* Lead gen */}
              <div style={section}>
                <div style={sTitle}>Lead generation</div>
                <p style={{ fontSize: 12, color: '#777', margin: '0 0 10px' }}>Percentage fees withheld from the restaurant&apos;s payout. Defaults 15% / 5%.</p>
                <div style={grid2}>
                  <div><label style={label}>Lead gen 1 (%)</label><input style={input} type="number" min={0} max={100} step="0.1" value={leadGenOne} onChange={e => setLeadGenOne(e.target.value)} /></div>
                  <div><label style={label}>Lead gen 2 (%)</label><input style={input} type="number" min={0} max={100} step="0.1" value={leadGenTwo} onChange={e => setLeadGenTwo(e.target.value)} /></div>
                </div>
              </div>

              {/* Disco fullmap listing — Premium flag + order-URL override (Neon) */}
              <div style={section}>
                <div style={sTitle}>Marketplace listing (Premium)</div>
                <p style={{ fontSize: 12, color: '#777', margin: '0 0 14px' }}>Controls the Disco fullmap. Saved to Disco (Neon), not Sanity.</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <label style={{ ...label, marginBottom: 0 }}>Premium</label>
                  {/* isDisco toggle, shown as a Premium pill. Click toggles. */}
                  <button type="button" onClick={() => setIsDisco(v => !v)} aria-pressed={isDisco}
                    style={{
                      border: 'none', borderRadius: 999, padding: '6px 14px', fontSize: 13, fontWeight: 700,
                      cursor: 'pointer', fontFamily: F, transition: 'opacity 0.15s',
                      ...(isDisco
                        ? { background: GRADIENT, color: '#fff' }
                        : { background: '#eee', color: '#999' }),
                    }}>
                    Premium 🪩
                  </button>
                  <span style={{ fontSize: 12, color: '#aaa' }}>{isDisco ? 'On' : 'Off — tap to enable'}</span>
                </div>
                <div>
                  <label style={label}>Order URL override</label>
                  <input style={input} value={orderUrlOverride} onChange={e => setOrderUrlOverride(e.target.value)}
                    placeholder="Leave blank to use /restaurants/<slug>" />
                </div>
              </div>

              {/* Marketplace (Sanity) — collapsible */}
              <div style={section}>
                <button type="button" onClick={() => setMpOpen(o => !o)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: F }}>
                  <span style={{ ...sTitle, marginBottom: 0 }}>Marketplace (Sanity){mpExists === false ? ' — no record' : ''}</span>
                  <span style={{ fontSize: 16, color: '#888' }}>{mpOpen ? '▾' : '▸'}</span>
                </button>
                {mpOpen && (
                  <div style={{ marginTop: 16 }}>
                    {mpExists === false && (
                      <div style={{ background: '#FFF8E6', border: '1px solid #F0D58A', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, color: '#8A6D1A' }}>
                        No Sanity record for this restaurant yet. Saving will create one (fmReference={restaurantRef}).
                      </div>
                    )}
                    <div style={{ marginBottom: 12 }}>
                      <label style={label}>Cuisines (max {MAX_CUISINES}) — {cuisines.length}/{MAX_CUISINES}</label>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {CUISINES.map(c => {
                          const on = cuisines.includes(c)
                          const atMax = !on && cuisines.length >= MAX_CUISINES
                          return (
                            <label key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, border: '1.5px solid ' + (on ? INDIGO : '#e0e0e0'), background: on ? 'rgba(107,110,249,0.08)' : '#fff', cursor: atMax ? 'not-allowed' : 'pointer', fontSize: 12, color: on ? INDIGO : (atMax ? '#bbb' : '#555') }}>
                              <input type="checkbox" checked={on} disabled={atMax} onChange={() => toggleCuisine(c)} style={{ accentColor: INDIGO }} />{c}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}><label style={label}>Location / display text</label><input style={input} value={location} onChange={e => setLocation(e.target.value)} placeholder="Brooklyn, NY" /></div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                        <label style={{ ...label, marginBottom: 0 }}>Description</label>
                        <button type="button" onClick={fetchGoogleDescription} disabled={fetchingDesc || !restaurantName.trim()}
                          style={{ background: '#EEF0FD', border: '1.5px solid #c8cafd', color: '#3A3DB0', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: (fetchingDesc || !restaurantName.trim()) ? 'default' : 'pointer', fontFamily: F, opacity: (fetchingDesc || !restaurantName.trim()) ? 0.6 : 1 }}>
                          {fetchingDesc ? 'Fetching…' : 'Fetch from Google 🔍'}
                        </button>
                      </div>
                      <textarea style={{ ...input, minHeight: 70, resize: 'vertical' }} maxLength={500} value={description} onChange={e => setDescription(e.target.value)} />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 11, color: '#DC2626' }}>{descError}</span>
                        <span style={{ fontSize: 11, color: '#aaa' }}>{description.length}/500</span>
                      </div>
                    </div>
                    <div style={grid2}>
                      <div><label style={label}>Latitude</label><input style={input} type="number" step="any" value={lat} onChange={e => setLat(e.target.value)} /></div>
                      <div><label style={label}>Longitude</label><input style={input} type="number" step="any" value={lng} onChange={e => setLng(e.target.value)} /></div>
                    </div>
                    <div style={{ marginBottom: 12 }}><label style={label}>Order URL</label><input style={input} value={orderUrl} onChange={e => setOrderUrl(e.target.value)} placeholder="https://www.familymeal.com/disco/…/catering" /></div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 22px', borderTop: '1px solid #ececf2', background: '#fff', flexShrink: 0 }}>
          <button onClick={onClose} disabled={saving} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }}>Cancel</button>
          <button onClick={submit} disabled={saving || loading} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: (saving || loading) ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Submit'}</button>
        </div>
      </div>
    </div>
  )
}
