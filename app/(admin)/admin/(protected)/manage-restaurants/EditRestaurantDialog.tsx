'use client'
import { useEffect, useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'

// Sanity marketplace enums (mirror the Sanity restaurant schema / brief).
const CUISINES = ['American', 'Italian', 'Mexican', 'Japanese', 'Chinese', 'Indian', 'Mediterranean', 'Thai', 'Korean', 'French', 'Middle Eastern', 'Caribbean', 'BBQ', 'Vegan', 'Other']
const TAG_OPTIONS = ["Editor's pick", 'Trending', 'New', 'Popular', 'Vegan-friendly', 'Gluten-free options', 'Halal']

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
  cuisine?: string
  description?: string
  location?: string
  lat?: number
  lng?: number
  tags?: string[]
  orderUrl?: string
  isDisco?: boolean
  featured?: boolean
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
  const [cuisine, setCuisine] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [orderUrl, setOrderUrl] = useState('')
  const [isDisco, setIsDisco] = useState(false)
  const [featured, setFeatured] = useState(false)
  const [heroFile, setHeroFile] = useState<File | null>(null)

  useEffect(() => {
    let cancel = false
    setLoading(true); setErr('')
    Promise.all([
      fetch(`/api/admin/restaurants/${restaurantRef}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/admin/restaurant-marketplace?fmReference=${restaurantRef}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([fm, mp]: [FmRestaurant | null, SanityMarketplace | null]) => {
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
        setCuisine(mp.cuisine || '')
        setDescription(mp.description || '')
        setLocation(mp.location || '')
        setLat(mp.lat != null ? String(mp.lat) : '')
        setLng(mp.lng != null ? String(mp.lng) : '')
        setTags(mp.tags || [])
        setOrderUrl(mp.orderUrl || '')
        setIsDisco(!!mp.isDisco)
        setFeatured(!!mp.featured)
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

  function toggleTag(t: string) {
    setTags(s => s.includes(t) ? s.filter(x => x !== t) : [...s, t])
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
          cuisine: cuisine || undefined,
          description: description || undefined,
          location: location || undefined,
          lat: lat === '' ? undefined : Number(lat),
          lng: lng === '' ? undefined : Number(lng),
          tags,
          orderUrl: orderUrl || undefined,
          isDisco,
          featured,
        }
        if (imageField) mpBody.image = imageField
        const mpRes = await fetch('/api/admin/restaurant-marketplace', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mpBody),
        })
        if (!mpRes.ok) {
          const d = await mpRes.json().catch(() => null)
          throw new Error(d?.error || 'Saved FM data, but the Marketplace (Sanity) write failed')
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
                  <div>
                    <label style={label}>Restaurant logo {existing?.image?.reference ? '(current set)' : ''}</label>
                    <input type="file" accept="image/*" onChange={e => setLogoFile(e.target.files?.[0] || null)} style={{ fontSize: 12 }} />
                  </div>
                  <div>
                    <label style={label}>Marketplace image {existing?.marketplaceImage?.image?.reference ? '(current set)' : ''}</label>
                    <input type="file" accept="image/*" onChange={e => setMarketImageFile(e.target.files?.[0] || null)} style={{ fontSize: 12 }} />
                  </div>
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
                    <div style={grid2}>
                      <div>
                        <label style={label}>Cuisine</label>
                        <select style={input} value={cuisine} onChange={e => setCuisine(e.target.value)}>
                          <option value="">—</option>
                          {CUISINES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <div><label style={label}>Location / display text</label><input style={input} value={location} onChange={e => setLocation(e.target.value)} placeholder="Brooklyn, NY" /></div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={label}>Description</label>
                      <textarea style={{ ...input, minHeight: 70, resize: 'vertical' }} maxLength={500} value={description} onChange={e => setDescription(e.target.value)} />
                      <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right' }}>{description.length}/500</div>
                    </div>
                    <div style={grid2}>
                      <div><label style={label}>Latitude</label><input style={input} type="number" step="any" value={lat} onChange={e => setLat(e.target.value)} /></div>
                      <div><label style={label}>Longitude</label><input style={input} type="number" step="any" value={lng} onChange={e => setLng(e.target.value)} /></div>
                    </div>
                    <div style={{ marginBottom: 12 }}><label style={label}>Order URL</label><input style={input} value={orderUrl} onChange={e => setOrderUrl(e.target.value)} placeholder="https://www.familymeal.com/disco/…/catering" /></div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={label}>Hero image</label>
                      <input type="file" accept="image/*" onChange={e => setHeroFile(e.target.files?.[0] || null)} style={{ fontSize: 12 }} />
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={label}>Tags</label>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {TAG_OPTIONS.map(t => (
                          <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, border: '1.5px solid ' + (tags.includes(t) ? INDIGO : '#e0e0e0'), background: tags.includes(t) ? 'rgba(107,110,249,0.08)' : '#fff', cursor: 'pointer', fontSize: 12, color: tags.includes(t) ? INDIGO : '#555' }}>
                            <input type="checkbox" checked={tags.includes(t)} onChange={() => toggleTag(t)} style={{ accentColor: INDIGO }} />{t}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 20 }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: DARK, cursor: 'pointer' }}>
                        <input type="checkbox" checked={isDisco} onChange={e => setIsDisco(e.target.checked)} style={{ accentColor: INDIGO }} /> isDisco (Premium)
                      </label>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: DARK, cursor: 'pointer' }}>
                        <input type="checkbox" checked={featured} onChange={e => setFeatured(e.target.checked)} style={{ accentColor: INDIGO }} /> Featured
                      </label>
                    </div>
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
