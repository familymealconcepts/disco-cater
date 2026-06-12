'use client'
import { useState, useEffect, useRef } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'
const FM_PUBLIC = 'https://api.familymeal.com'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Admin {
  firstName: string
  lastName: string
  email: string
  phoneNumber: string
}

interface Address {
  businessName: string
  phoneNumber: string
  addressLine1: string
  city: string
  state: string
  zipcode: string
  latitude?: number
  longitude?: number
}

interface Restaurant {
  reference: string
  businessName: string
  // FM's URL-safe slug (e.g. "twohandsfranklin"). Used to build the direct
  // (1st-party) ordering link. Falls back to a derived slug if absent.
  businessNameWithoutSpaces?: string
  businessLegalName: string
  timezone: string
  pickupInstructions: string
  deliveryType: string
  admin: Admin
  address: Address
  image?: { reference?: string }
  marketplaceImage?: { reference?: string }
}

interface BusinessInfo {
  businessLegalName: string
  city: string
  state: string
  zipcode: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inp(
  value: string,
  onChange: (v: string) => void,
  opts?: { placeholder?: string; disabled?: boolean; type?: string; maxLength?: number }
): React.ReactElement {
  return (
    <input
      type={opts?.type || 'text'}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={opts?.placeholder}
      disabled={opts?.disabled}
      maxLength={opts?.maxLength}
      style={{
        width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8,
        padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none',
        background: opts?.disabled ? '#f5f5f5' : '#fff',
        color: opts?.disabled ? '#999' : DARK,
      }}
    />
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function Card({
  title, children, onSave, saving, success, error,
}: {
  title: string
  children: React.ReactNode
  onSave?: () => void
  saving?: boolean
  success?: string
  error?: string
}) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '24px', marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 20px' }}>{title}</h2>
      {error && (
        <div style={{ background: '#FFF0F0', border: '1px solid #FFCDD2', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#C62828' }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ background: '#E8F5E9', border: '1px solid #A5D6A7', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#2E7D32' }}>
          {success}
        </div>
      )}
      {children}
      {onSave && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button
            onClick={onSave}
            disabled={saving}
            style={{
              padding: '9px 20px', background: BLUE, color: '#fff', border: 'none',
              borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
              fontFamily: F, opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

// FM's businessNameWithoutSpaces when present, else derived from the business
// name (lowercase, alphanumerics only) to match FM's slug format.
function restaurantSlug(r: Restaurant | null): string {
  if (!r) return ''
  if (r.businessNameWithoutSpaces) return r.businessNameWithoutSpaces
  return (r.businessName || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Read-only "Ordering Links" card. Shows ONLY the 1st-party (commission-free)
// direct link the restaurant can put on its own site. The 3rd-party
// marketplace link (/restaurants/[slug]) is deliberately NOT shown — it's
// controlled by Disco employees only.
function OrderingLinksCard({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const directLink = `https://www.discocater.com/order/${slug}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(directLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (insecure context / older browser) — no-op;
      // the link text stays selectable for a manual copy.
    }
  }

  return (
    <Card title="Ordering Links">
      <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 6 }}>
        Direct ordering link
      </div>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
        Share this link on your website (commission-free).
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <input
          type="text"
          value={directLink}
          readOnly
          onFocus={e => e.currentTarget.select()}
          style={{
            flex: 1, border: '1.5px solid #e0e0e0', borderRadius: 8,
            padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none',
            background: '#f9f9fb', color: DARK,
          }}
        />
        <button
          onClick={copy}
          style={{
            padding: '9px 16px', background: copied ? '#22C55E' : BLUE, color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
            cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </Card>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProfilePage() {
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo>({ businessLegalName: '', city: '', state: '', zipcode: '' })

  // Profile card state
  const [admin, setAdmin] = useState<Admin>({ firstName: '', lastName: '', email: '', phoneNumber: '' })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSuccess, setProfileSuccess] = useState('')
  const [profileError, setProfileError] = useState('')

  // Password card state
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwSuccess, setPwSuccess] = useState('')
  const [pwError, setPwError] = useState('')

  // Business info card state
  const [bizSaving, setBizSaving] = useState(false)
  const [bizSuccess, setBizSuccess] = useState('')
  const [bizError, setBizError] = useState('')

  // Address card state
  const [address, setAddress] = useState<Address>({ businessName: '', phoneNumber: '', addressLine1: '', city: '', state: '', zipcode: '' })
  const [addrSaving, setAddrSaving] = useState(false)
  const [addrSuccess, setAddrSuccess] = useState('')
  const [addrError, setAddrError] = useState('')

  // DoorDash card state
  const [pickupInstructions, setPickupInstructions] = useState('')
  const [ddSaving, setDdSaving] = useState(false)
  const [ddSuccess, setDdSuccess] = useState('')
  const [ddError, setDdError] = useState('')

  // Image state
  const [imgUploading, setImgUploading] = useState<'restaurant' | 'marketplace' | null>(null)
  const [imgError, setImgError] = useState('')
  const [imgSuccess, setImgSuccess] = useState('')
  const restaurantImgRef = useRef<HTMLInputElement>(null)
  const marketplaceImgRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(true)

  // Stripe Connect status — drives the "connect your bank" warning banner.
  // null = unknown/loading; false = not connected (show banner).
  const [stripeConnected, setStripeConnected] = useState<boolean | null>(null)
  const [connectingStripe, setConnectingStripe] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/restaurant/stripe-status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setStripeConnected(!!d?.connected) })
      .catch(() => { if (!cancelled) setStripeConnected(null) })
    return () => { cancelled = true }
  }, [])

  // Start Stripe Connect onboarding (same route the Banking page uses) and
  // redirect to the returned hosted URL.
  async function connectStripe() {
    setConnectingStripe(true)
    try {
      const res = await fetch('/api/restaurant/stripe/connect', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (res.ok && d?.stripeConnectUrl) { window.location.href = d.stripeConnectUrl; return }
    } catch { /* fall through to re-enable the button */ }
    setConnectingStripe(false)
  }

  useEffect(() => {
    Promise.all([
      fetch('/api/restaurant/profile').then(r => r.ok ? r.json() : null),
      fetch('/api/restaurant/business-info').then(r => r.ok ? r.json() : null),
    ]).then(([rest, biz]) => {
      if (rest) {
        setRestaurant(rest)
        setAdmin({
          firstName: rest.admin?.firstName || '',
          lastName: rest.admin?.lastName || '',
          email: rest.admin?.email || '',
          phoneNumber: rest.admin?.phoneNumber || '',
        })
        setAddress({
          businessName: rest.address?.businessName || '',
          phoneNumber: rest.address?.phoneNumber || '',
          addressLine1: rest.address?.addressLine1 || '',
          city: rest.address?.city || '',
          state: rest.address?.state || '',
          zipcode: rest.address?.zipcode || '',
          latitude: rest.address?.latitude,
          longitude: rest.address?.longitude,
        })
        setPickupInstructions(rest.pickupInstructions || '')
      }
      if (biz) {
        setBusinessInfo({
          businessLegalName: biz.businessLegalName || '',
          city: biz.city || '',
          state: biz.state || '',
          zipcode: biz.zipcode || '',
        })
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  function buildRestaurantPayload(overrides: Partial<Restaurant> = {}): Restaurant {
    return {
      reference: restaurant?.reference || '',
      businessName: restaurant?.businessName || '',
      businessLegalName: restaurant?.businessLegalName || '',
      timezone: restaurant?.timezone || '',
      pickupInstructions,
      deliveryType: restaurant?.deliveryType || '',
      admin: {
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        phoneNumber: admin.phoneNumber,
      },
      address: {
        businessName: address.businessName,
        phoneNumber: address.phoneNumber,
        addressLine1: address.addressLine1,
        city: address.city,
        state: address.state,
        zipcode: address.zipcode,
        latitude: address.latitude,
        longitude: address.longitude,
      },
      ...overrides,
    }
  }

  async function saveProfile() {
    setProfileSaving(true)
    setProfileError('')
    setProfileSuccess('')
    try {
      const payload = buildRestaurantPayload()
      const res = await fetch('/api/restaurant/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setProfileError('Failed to save profile. Please try again.')
      } else {
        setProfileSuccess('Profile updated.')
        setTimeout(() => setProfileSuccess(''), 3000)
      }
    } catch {
      setProfileError('Network error. Please try again.')
    }
    setProfileSaving(false)
  }

  async function savePassword() {
    if (password.length < 8 || newPassword.length < 8) {
      setPwError('Passwords must be at least 8 characters.')
      return
    }
    setPwSaving(true)
    setPwError('')
    setPwSuccess('')
    try {
      const res = await fetch('/api/restaurant/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: password, newPassword }),
      })
      if (!res.ok) {
        setPwError('Failed to change password. Check your current password.')
      } else {
        setPwSuccess('Password changed.')
        setPassword('')
        setNewPassword('')
        setTimeout(() => setPwSuccess(''), 3000)
      }
    } catch {
      setPwError('Network error. Please try again.')
    }
    setPwSaving(false)
  }

  async function saveBusinessInfo() {
    setBizSaving(true)
    setBizError('')
    setBizSuccess('')
    try {
      const res = await fetch('/api/restaurant/business-info', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(businessInfo),
      })
      if (!res.ok) {
        setBizError('Failed to save business info. Please try again.')
      } else {
        setBizSuccess('Business info updated.')
        setTimeout(() => setBizSuccess(''), 3000)
      }
    } catch {
      setBizError('Network error. Please try again.')
    }
    setBizSaving(false)
  }

  async function saveAddress() {
    setAddrSaving(true)
    setAddrError('')
    setAddrSuccess('')
    try {
      const payload = buildRestaurantPayload()
      const res = await fetch('/api/restaurant/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setAddrError('Failed to save address. Please try again.')
      } else {
        setAddrSuccess('Address updated.')
        setTimeout(() => setAddrSuccess(''), 3000)
      }
    } catch {
      setAddrError('Network error. Please try again.')
    }
    setAddrSaving(false)
  }

  async function saveDoorDash() {
    setDdSaving(true)
    setDdError('')
    setDdSuccess('')
    try {
      const payload = buildRestaurantPayload({ pickupInstructions })
      const res = await fetch('/api/restaurant/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setDdError('Failed to save. Please try again.')
      } else {
        setDdSuccess('DoorDash settings updated.')
        setTimeout(() => setDdSuccess(''), 3000)
      }
    } catch {
      setDdError('Network error. Please try again.')
    }
    setDdSaving(false)
  }

  async function uploadImage(type: 'restaurant' | 'marketplace', file: File) {
    setImgUploading(type)
    setImgError('')
    setImgSuccess('')
    const formData = new FormData()
    formData.append('file', file)
    try {
      const endpoint = type === 'restaurant'
        ? '/api/restaurant/images/upload'
        : '/api/restaurant/images/marketplace'
      const res = await fetch(endpoint, { method: 'POST', body: formData })
      if (!res.ok) {
        setImgError('Failed to upload image. Please try again.')
      } else {
        setImgSuccess('Image uploaded successfully.')
        setTimeout(() => setImgSuccess(''), 3000)
        // Refresh restaurant data to get new image reference
        const updated = await fetch('/api/restaurant/profile').then(r => r.ok ? r.json() : null)
        if (updated) setRestaurant(updated)
      }
    } catch {
      setImgError('Network error. Please try again.')
    }
    setImgUploading(null)
  }

  if (loading) {
    return (
      <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }

  const isDoorDash = restaurant?.deliveryType === 'DOOR_DASH_DELIVERY'

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      {/* Stripe-not-connected warning — only shown once we know it's disconnected */}
      {stripeConnected === false && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 12,
          padding: '14px 18px', marginBottom: 20,
        }}>
          <div style={{ flex: 1, minWidth: 220, fontSize: 14, fontWeight: 600, color: '#9A3412' }}>
            ⚠️ Connect your bank account to start receiving payments.
          </div>
          <button onClick={connectStripe} disabled={connectingStripe}
            style={{
              padding: '9px 18px', background: '#EA580C', color: '#fff', border: 'none',
              borderRadius: 8, fontSize: 13, fontWeight: 700, fontFamily: F, whiteSpace: 'nowrap',
              cursor: connectingStripe ? 'default' : 'pointer', opacity: connectingStripe ? 0.7 : 1,
            }}>
            {connectingStripe ? 'Connecting…' : 'Connect to Stripe →'}
          </button>
        </div>
      )}
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 24px' }}>Profile</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))', gap: 20, alignItems: 'start' }}>
        {/* Card 1: Personal Info */}
        <Card title="Profile" onSave={saveProfile} saving={profileSaving} success={profileSuccess} error={profileError}>
          <FormField label="First Name">
            {inp(admin.firstName, v => setAdmin({ ...admin, firstName: v }))}
          </FormField>
          <FormField label="Last Name">
            {inp(admin.lastName, v => setAdmin({ ...admin, lastName: v }))}
          </FormField>
          <FormField label="Email">
            {inp(admin.email, () => {}, { disabled: true })}
          </FormField>
          <FormField label="Phone Number">
            {inp(admin.phoneNumber, v => setAdmin({ ...admin, phoneNumber: v }), { type: 'tel' })}
          </FormField>
        </Card>

        {/* Ordering Links — read-only, 1st-party direct link only */}
        <OrderingLinksCard slug={restaurantSlug(restaurant)} />

        {/* Card 2: Change Password */}
        <Card title="Change Password" onSave={savePassword} saving={pwSaving} success={pwSuccess} error={pwError}>
          <FormField label="Current Password">
            {inp(password, setPassword, { type: 'password' })}
          </FormField>
          <FormField label="New Password">
            {inp(newPassword, setNewPassword, { type: 'password' })}
          </FormField>
        </Card>

        {/* Card 3: Business Info */}
        <Card title="Business Info" onSave={saveBusinessInfo} saving={bizSaving} success={bizSuccess} error={bizError}>
          <FormField label="Business Legal Name">
            {inp(businessInfo.businessLegalName, v => setBusinessInfo({ ...businessInfo, businessLegalName: v }))}
          </FormField>
          <FormField label="City">
            {inp(businessInfo.city, v => setBusinessInfo({ ...businessInfo, city: v }))}
          </FormField>
          <FormField label="State">
            {inp(businessInfo.state, v => setBusinessInfo({ ...businessInfo, state: v }))}
          </FormField>
          <FormField label="Zip Code">
            {inp(businessInfo.zipcode, v => setBusinessInfo({ ...businessInfo, zipcode: v }))}
          </FormField>
        </Card>

        {/* Card 4: Restaurant Address */}
        <Card title="Restaurant Address" onSave={saveAddress} saving={addrSaving} success={addrSuccess} error={addrError}>
          <FormField label="Business Name">
            {inp(address.businessName, v => setAddress({ ...address, businessName: v }))}
          </FormField>
          <FormField label="Phone Number">
            {inp(address.phoneNumber, v => setAddress({ ...address, phoneNumber: v }), { type: 'tel' })}
          </FormField>
          <FormField label="Address">
            {inp(address.addressLine1, v => setAddress({ ...address, addressLine1: v }))}
          </FormField>
          <FormField label="City">
            {inp(address.city, v => setAddress({ ...address, city: v }))}
          </FormField>
          <FormField label="State">
            {inp(address.state, v => setAddress({ ...address, state: v }))}
          </FormField>
          <FormField label="Zip Code">
            {inp(address.zipcode, v => setAddress({ ...address, zipcode: v }))}
          </FormField>
        </Card>

        {/* Card 5: DoorDash (conditional) */}
        {isDoorDash && (
          <Card title="DoorDash Settings" onSave={saveDoorDash} saving={ddSaving} success={ddSuccess} error={ddError}>
            <FormField label="Pickup Instructions">
              <textarea
                value={pickupInstructions}
                onChange={e => setPickupInstructions(e.target.value)}
                maxLength={1000}
                rows={4}
                style={{
                  width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8,
                  padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none',
                  resize: 'vertical',
                }}
              />
              <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right', marginTop: 4 }}>
                {pickupInstructions.length}/1000
              </div>
            </FormField>
          </Card>
        )}

        {/* Card 6: Images */}
        <Card title="Restaurant Images">
          {imgError && (
            <div style={{ background: '#FFF0F0', border: '1px solid #FFCDD2', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#C62828' }}>
              {imgError}
            </div>
          )}
          {imgSuccess && (
            <div style={{ background: '#E8F5E9', border: '1px solid #A5D6A7', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#2E7D32' }}>
              {imgSuccess}
            </div>
          )}

          {/* Restaurant image (square) */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 8 }}>
              Restaurant Image (square)
            </label>
            {restaurant?.image?.reference && (
              <img
                src={`${FM_PUBLIC}/public-api/images/${restaurant.image.reference}/download?size=150`}
                alt="Restaurant"
                style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 8, border: '1px solid #eee', display: 'block', marginBottom: 10 }}
              />
            )}
            <input
              ref={restaurantImgRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files?.[0]
                if (file) uploadImage('restaurant', file)
              }}
            />
            <button
              onClick={() => restaurantImgRef.current?.click()}
              disabled={imgUploading !== null}
              style={{
                padding: '8px 14px', background: '#fff', border: '1px solid #ddd', borderRadius: 8,
                fontSize: 13, cursor: imgUploading !== null ? 'default' : 'pointer', fontFamily: F,
                color: DARK, opacity: imgUploading !== null ? 0.6 : 1,
              }}
            >
              {imgUploading === 'restaurant' ? 'Uploading…' : 'Upload Image'}
            </button>
          </div>

          {/* Marketplace image (4:3) */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 8 }}>
              Marketplace Image (4:3)
            </label>
            {restaurant?.marketplaceImage?.reference && (
              <img
                src={`${FM_PUBLIC}/public-api/images/${restaurant.marketplaceImage.reference}/download?size=150`}
                alt="Marketplace"
                style={{ width: 150, height: 113, objectFit: 'cover', borderRadius: 8, border: '1px solid #eee', display: 'block', marginBottom: 10 }}
              />
            )}
            <input
              ref={marketplaceImgRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files?.[0]
                if (file) uploadImage('marketplace', file)
              }}
            />
            <button
              onClick={() => marketplaceImgRef.current?.click()}
              disabled={imgUploading !== null}
              style={{
                padding: '8px 14px', background: '#fff', border: '1px solid #ddd', borderRadius: 8,
                fontSize: 13, cursor: imgUploading !== null ? 'default' : 'pointer', fontFamily: F,
                color: DARK, opacity: imgUploading !== null ? 0.6 : 1,
              }}
            >
              {imgUploading === 'marketplace' ? 'Uploading…' : 'Upload Image'}
            </button>
          </div>
        </Card>
      </div>
    </div>
  )
}
