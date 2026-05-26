'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import Cropper, { type Area } from 'react-easy-crop'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || ''
const FM_PUBLIC_API = 'https://api.familymeal.com'

declare global {
  interface Window {
    initGooglePlacesEdit?: () => void
  }
}

interface GoogleAutocomplete {
  addListener: (event: string, cb: () => void) => void
  getPlace: () => {
    formatted_address?: string
    address_components?: { types: string[]; short_name: string; long_name: string }[]
    geometry?: { location: { lat: () => number; lng: () => number } }
  }
}

interface GoogleMapsWindow {
  google?: {
    maps?: {
      places?: { Autocomplete: new (input: HTMLInputElement, opts?: object) => GoogleAutocomplete }
    }
  }
}

export const RESTAURANT_CATEGORIES = [
  { title: 'Event', value: 'EVENT' },
  { title: 'Office', value: 'OFFICE' },
  { title: 'Holiday', value: 'HOLIDAY' },
  { title: 'Pop-up', value: 'POP_UP' },
  { title: 'Meal Prep', value: 'MEAL_PREP' },
  { title: 'Private Chef', value: 'PRIVATE_CHEF' },
  { title: 'Wholesale', value: 'WHOLESALE' },
  { title: 'Subscriptions', value: 'SUBSCRIPTIONS' },
  { title: 'Exclusives', value: 'EXCLUSIVES' },
]

export const RECEIVING_TYPES = [
  { title: 'Pickup', value: 'PICKUP' },
  { title: 'Delivery', value: 'DELIVERY' },
  { title: 'Shipping', value: 'SHIPPING' },
]

export interface EditLocationFullData {
  reference: string
  businessName: string
  businessNameWithoutSpaces?: string
  timezone?: string
  restaurantCategories?: string[]
  fulfillmentOptions?: string[]
  address?: {
    addressLine1?: string
    addressLine2?: string
    city?: string
    state?: string
    zipcode?: string
    latitude?: number
    longitude?: number
    phoneNumber?: string
  }
  image?: { reference?: string }
  marketplaceImage?: { image?: { reference?: string } }
}

interface Props {
  location: EditLocationFullData
  onClose: () => void
  onSaved: (msg: string) => void
}

export default function EditLocationDialog({ location, onClose, onSaved }: Props) {
  const [businessName, setBusinessName] = useState(location.businessName || '')
  const [phoneNumber, setPhoneNumber] = useState(location.address?.phoneNumber || '')
  const [addressLine1, setAddressLine1] = useState(location.address?.addressLine1 || '')
  const [addressLine2, setAddressLine2] = useState(location.address?.addressLine2 || '')
  const [city, setCity] = useState(location.address?.city || '')
  const [state, setState] = useState(location.address?.state || '')
  const [zipcode, setZipcode] = useState(location.address?.zipcode || '')
  const [latitude, setLatitude] = useState<number | undefined>(location.address?.latitude)
  const [longitude, setLongitude] = useState<number | undefined>(location.address?.longitude)
  const [timezone, setTimezone] = useState<string | undefined>(location.timezone)

  const initialCats = new Set(location.restaurantCategories || [])
  const initialRecv = new Set(location.fulfillmentOptions || [])
  const [cats, setCats] = useState<Set<string>>(initialCats)
  const [recv, setRecv] = useState<Set<string>>(initialRecv)

  // Image state
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string>(
    location.image?.reference
      ? `${FM_PUBLIC_API}/public-api/images/${location.image.reference}/download?size=150`
      : ''
  )
  const [marketplaceFile, setMarketplaceFile] = useState<File | null>(null)
  const [marketplacePreview, setMarketplacePreview] = useState<string>(
    location.marketplaceImage?.image?.reference
      ? `${FM_PUBLIC_API}/public-api/images/${location.marketplaceImage.image.reference}/download?size=150`
      : ''
  )

  // Cropper modal state
  const [cropper, setCropper] = useState<null | { src: string; ratio: number; kind: 'logo' | 'marketplace' }>(null)

  // CSV state
  const [csvFile, setCsvFile] = useState<File | null>(null)

  // Form state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Google Places autocomplete
  const addressRef = useRef<HTMLInputElement | null>(null)
  const acRef = useRef<GoogleAutocomplete | null>(null)

  useEffect(() => {
    function init() {
      const places = (window as unknown as GoogleMapsWindow).google?.maps?.places
      if (!addressRef.current || !places) return
      if (acRef.current) return
      acRef.current = new places.Autocomplete(addressRef.current, {
        types: ['address'],
        componentRestrictions: { country: 'us' },
        fields: ['address_components', 'formatted_address', 'geometry'],
      })
      acRef.current.addListener('place_changed', () => {
        const place = acRef.current?.getPlace()
        if (!place) return
        const ac = place.address_components || []
        const find = (...types: string[]) => ac.find(c => types.some(t => c.types.includes(t)))
        const localityComp = find('locality') || find('sublocality_level_1')
        const stateComp = find('administrative_area_level_1')
        const zipComp = find('postal_code')
        setAddressLine1(place.formatted_address || '')
        if (localityComp) setCity(localityComp.short_name)
        if (stateComp) setState(stateComp.short_name)
        if (zipComp) setZipcode(zipComp.short_name)
        const lat = place.geometry?.location?.lat()
        const lng = place.geometry?.location?.lng()
        if (lat !== undefined) setLatitude(lat)
        if (lng !== undefined) setLongitude(lng)
        if (lat !== undefined && lng !== undefined && GOOGLE_MAPS_API_KEY) {
          // Look up timezone
          const ts = Math.floor(Date.now() / 1000)
          fetch(`https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${ts}&key=${GOOGLE_MAPS_API_KEY}`)
            .then(r => r.json())
            .then(d => { if (d?.timeZoneId) setTimezone(d.timeZoneId) })
            .catch(() => {})
        }
      })
    }
    if ((window as unknown as GoogleMapsWindow).google?.maps?.places) {
      init()
    } else if (!document.getElementById('google-maps-script-edit')) {
      window.initGooglePlacesEdit = init
      const s = document.createElement('script')
      s.id = 'google-maps-script-edit'
      s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=initGooglePlacesEdit`
      s.async = true
      s.defer = true
      document.head.appendChild(s)
    } else {
      // Script is loading; poll
      const t = setInterval(() => {
        if ((window as unknown as GoogleMapsWindow).google?.maps?.places) { init(); clearInterval(t) }
      }, 200)
      return () => clearInterval(t)
    }
  }, [])

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>, kind: 'logo' | 'marketplace') {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setCropper({ src: String(reader.result), ratio: kind === 'logo' ? 1 : 4 / 3, kind })
    }
    reader.readAsDataURL(file)
    // Reset the input so re-selecting the same file fires onChange again
    e.target.value = ''
  }

  function cropApply(file: File, dataUrl: string) {
    if (!cropper) return
    if (cropper.kind === 'logo') {
      setLogoFile(file)
      setLogoPreview(dataUrl)
    } else {
      setMarketplaceFile(file)
      setMarketplacePreview(dataUrl)
    }
    setCropper(null)
  }

  function buildPayload() {
    const businessNameWithoutSpaces = (location.businessNameWithoutSpaces ||
      businessName.toLowerCase().replace(/[^a-z0-9]/g, ''))
    return {
      reference: location.reference,
      businessName,
      businessNameWithoutSpaces,
      timezone: timezone || '',
      categories: Array.from(cats),
      fulfillmentOptions: Array.from(recv),
      address: {
        addressLine1, addressLine2, city, state, zipcode,
        latitude: typeof latitude === 'number' ? latitude : undefined,
        longitude: typeof longitude === 'number' ? longitude : undefined,
        phoneNumber,
      },
    }
  }

  const validAddress = typeof latitude === 'number' && typeof longitude === 'number'
  const validCats = cats.size > 0 && recv.size > 0
  const phoneOk = !phoneNumber || /^(\+\d{1}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test(phoneNumber)
  const submitDisabled = !businessName || !addressLine1 || !validAddress || !validCats || !phoneOk || saving

  async function save() {
    if (submitDisabled) return
    setSaving(true)
    setError('')
    try {
      const payload = buildPayload()
      // Send multipart so the optional CSV travels with the restaurant blob.
      const fd = new FormData()
      fd.append('restaurant', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
      if (csvFile) fd.append('file', csvFile, csvFile.name)
      const res = await fetch(`/api/restaurant/locations/${location.reference}`, { method: 'PUT', body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d?.error || 'Save failed')
        setSaving(false)
        return
      }
      // Then upload images if changed
      if (logoFile) {
        const lf = new FormData()
        lf.append('file', logoFile, logoFile.name)
        await fetch(`/api/restaurant/locations/${location.reference}/logo`, { method: 'POST', body: lf })
      }
      if (marketplaceFile) {
        const mf = new FormData()
        mf.append('file', marketplaceFile, marketplaceFile.name)
        await fetch(`/api/restaurant/locations/${location.reference}/marketplace-logo`, { method: 'POST', body: mf })
      }
      onSaved(`${businessName} updated.`)
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div style={modalBackdrop}>
        <div style={{ ...modalBody, maxWidth: 760, maxHeight: '92vh', overflow: 'auto' }}>
          <h3 style={{ margin: '0 0 18px', fontSize: 18, fontWeight: 700, color: DARK }}>Edit Location</h3>

          {/* Name + Phone */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <Field label="Restaurant name*">
              <input style={inputSt} value={businessName} onChange={e => setBusinessName(e.target.value)} />
            </Field>
            <Field label="Phone*">
              <input style={inputSt} value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="000-000-0000" />
              {phoneNumber && !phoneOk && <small style={errSmall}>Use 000-000-0000 format</small>}
            </Field>
          </div>

          {/* Address line 1 (Google Places) */}
          <Field label="Address line 1*">
            <input
              ref={addressRef}
              style={inputSt}
              value={addressLine1}
              onChange={e => setAddressLine1(e.target.value)}
              placeholder="Start typing to autocomplete"
              autoComplete="off"
            />
            {!validAddress && addressLine1 && (
              <small style={errSmall}>Select a suggestion to set location coordinates</small>
            )}
          </Field>

          {/* Address line 2 */}
          <Field label="Address line 2">
            <input style={inputSt} value={addressLine2} onChange={e => setAddressLine2(e.target.value)} />
          </Field>

          {/* City / State / Zip */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
            <Field label="City">
              <input style={inputSt} value={city} onChange={e => setCity(e.target.value)} />
            </Field>
            <Field label="State">
              <input style={inputSt} value={state} onChange={e => setState(e.target.value)} maxLength={2} />
            </Field>
            <Field label="Zip">
              <input style={inputSt} value={zipcode} onChange={e => setZipcode(e.target.value)} />
            </Field>
          </div>

          {/* Images */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <ImageBlock
              title="Restaurant logo (1:1)"
              preview={logoPreview}
              onSelect={e => handleImageSelect(e, 'logo')}
              accept="image/png,image/jpeg"
            />
            <ImageBlock
              title="Marketplace image (4:3)"
              preview={marketplacePreview}
              onSelect={e => handleImageSelect(e, 'marketplace')}
              accept="image/png,image/jpeg"
            />
          </div>

          {/* Categories + Receiving */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <Field label="Categories*">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {RESTAURANT_CATEGORIES.map(c => (
                  <label key={c.value} style={checkLabel}>
                    <input type="checkbox" checked={cats.has(c.value)}
                      onChange={() => {
                        const next = new Set(cats)
                        if (next.has(c.value)) next.delete(c.value); else next.add(c.value)
                        setCats(next)
                      }} />
                    {c.title}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Delivery / Pickup*">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {RECEIVING_TYPES.map(t => (
                  <label key={t.value} style={checkLabel}>
                    <input type="checkbox" checked={recv.has(t.value)}
                      onChange={() => {
                        const next = new Set(recv)
                        if (next.has(t.value)) next.delete(t.value); else next.add(t.value)
                        setRecv(next)
                      }} />
                    {t.title}
                  </label>
                ))}
              </div>
            </Field>
          </div>

          {/* CSV */}
          <Field label="Restaurant Menu (.csv, optional)">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={e => setCsvFile(e.target.files?.[0] || null)}
              style={{ fontSize: 13, fontFamily: F, color: DARK }}
            />
            {csvFile && <small style={{ display: 'block', color: '#666', marginTop: 4 }}>{csvFile.name}</small>}
          </Field>

          {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginTop: 10, fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
            <button onClick={onClose} disabled={saving} style={secondaryBtn}>Cancel</button>
            <button onClick={save} disabled={submitDisabled} style={{ ...primaryBtn, opacity: submitDisabled ? 0.5 : 1, cursor: submitDisabled ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {cropper && (
        <CropModal
          src={cropper.src}
          aspect={cropper.ratio}
          onCancel={() => setCropper(null)}
          onApply={cropApply}
        />
      )}
    </>
  )
}

function ImageBlock({ title, preview, onSelect, accept }: {
  title: string; preview: string; onSelect: (e: React.ChangeEvent<HTMLInputElement>) => void; accept: string
}) {
  const inputId = `img-${title.replace(/\s+/g, '-')}`
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 6 }}>{title}</label>
      <div style={{ border: '1.5px dashed #ccc', borderRadius: 10, padding: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }} />
        ) : (
          <div style={{ width: 56, height: 56, background: '#f0f0f0', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: 10 }}>none</div>
        )}
        <label htmlFor={inputId} style={{ cursor: 'pointer', color: BLUE, fontSize: 12, fontWeight: 600 }}>
          {preview ? 'Change' : 'Choose image'}
        </label>
        <input id={inputId} type="file" accept={accept} onChange={onSelect} style={{ display: 'none' }} />
      </div>
    </div>
  )
}

// ── Crop modal ───────────────────────────────────────────────────────────────

function CropModal({ src, aspect, onCancel, onApply }: {
  src: string; aspect: number; onCancel: () => void; onApply: (file: File, dataUrl: string) => void
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedArea(areaPixels)
  }, [])

  async function apply() {
    if (!croppedArea) return
    const { dataUrl, file } = await produceCroppedImage(src, croppedArea)
    onApply(file, dataUrl)
  }

  return (
    <div style={{ ...modalBackdrop, zIndex: 401 }}>
      <div style={{ ...modalBody, maxWidth: 560 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: DARK }}>Crop image</h3>
        <div style={{ position: 'relative', width: '100%', height: 360, background: '#222', borderRadius: 10, overflow: 'hidden' }}>
          <Cropper
            image={src}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <span style={{ fontSize: 12, color: '#666' }}>Zoom</span>
          <input type="range" min={1} max={3} step={0.1} value={zoom} onChange={e => setZoom(Number(e.target.value))} style={{ flex: 1 }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
          <button onClick={apply} style={primaryBtn}>Apply crop</button>
        </div>
      </div>
    </div>
  )
}

async function produceCroppedImage(src: string, area: Area): Promise<{ dataUrl: string; file: File }> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => resolve(i)
    i.onerror = reject
    i.src = src
  })
  const canvas = document.createElement('canvas')
  canvas.width = area.width
  canvas.height = area.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas')
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.92)
  )
  const file = new File([blob], `crop-${Date.now()}.jpg`, { type: 'image/jpeg' })
  return { dataUrl, file }
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  )
}

const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
const secondaryBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }
const checkLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer', color: DARK, padding: '4px 8px', background: '#f8f8fc', borderRadius: 6 }
const modalBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
const modalBody: React.CSSProperties = { background: '#fff', borderRadius: 14, padding: '28px 32px', width: '100%', fontFamily: F }
const errSmall: React.CSSProperties = { display: 'block', color: '#c00', fontSize: 11, marginTop: 4 }
