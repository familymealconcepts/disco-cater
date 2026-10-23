'use client'
import { useState, useEffect, useRef } from 'react'
import { checkOrderingWouldDisable } from '../../../../../../lib/ordering-validation'
import { useSelectedRestaurant } from '../../_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'
// Round "×" overlaid on an image preview's top-right corner. Identical copy of
// removeImageX in manage/multi-unit-links/page.tsx — keep them in step.
const removeImageX: React.CSSProperties = { position: 'absolute', top: -8, right: -8, width: 22, height: 22, borderRadius: '50%', border: '2px solid #fff', background: '#1A1028', color: '#fff', fontSize: 14, fontWeight: 700, lineHeight: 1, padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.25)', fontFamily: F }

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

// Disco-native restaurant profile (name / address / phone / logo), stored in
// disco_restaurant_accounts + disco_restaurant_cache during onboarding. Editable
// here; saved to Neon (never synced to FM).
interface DiscoProfile {
  restaurantName: string
  phone: string
  address: string
  addressLine2: string // optional suite / unit / floor → disco_restaurant_cache.address_line2
  logoUrl: string   // Marketplace Image → disco_restaurant_cache.image_url
  iconUrl: string   // Logo → disco_restaurant_cache.icon_url
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// name + autoComplete are REQUIRED, not optional — this is the fix for the bug
// where an unlabeled type="tel" field sitting next to an email field let a
// browser drop a saved email into the phone field (confirmed 2026-08-12: the
// database itself was clean, this was purely a client-side autofill
// misclassification). Making them required means a future field added to this
// page can't silently omit them the way the old optional opts did.
//
// ── AND IT STILL HAPPENS, SO THERE IS NOW A SECOND LINE ─────────────────────
// Reported again on Rooted Cafe (kealoha@familymeal.com in Phone Number) and on
// Utopia Bagels (peteventi+1@gmail.com). Re-checked 2026-10-11: the database is
// still clean — ZERO rows across disco_restaurant_accounts.phone,
// disco_restaurant_cache.phone and overrides.notification_sms_numbers contain
// an "@" — and every input on this page does carry name + autoComplete. So the
// markup fix is in place and holding; Chrome is simply overriding it, which it
// is free to do because autoComplete is a hint and not a rule.
//
// autoComplete is advisory, so the only thing that can actually guarantee this
// is the VALUE. A tel field now refuses an email-shaped value: it is filtered
// on the way in (so the stray fill never renders) and stripped again before
// save (so it can never be persisted even if something slips past the input).
// The database is clean today and this is what keeps it that way.
const EMAILISH = /@/

/** Phone fields accept digits and the punctuation a phone number uses, nothing
 *  else. Returns '' for an email-shaped value rather than trying to repair it. */
export function sanitizePhoneInput(v: string): string {
  if (!v) return ''
  if (EMAILISH.test(v)) return ''
  return v.replace(/[^0-9+()\-.\s ext]/gi, '')
}
function inp(
  value: string,
  onChange: (v: string) => void,
  opts: {
    name: string
    autoComplete: string
    placeholder?: string
    disabled?: boolean
    type?: string
    maxLength?: number
  }
): React.ReactElement {
  return (
    <input
      id={opts.name}
      name={opts.name}
      autoComplete={opts.autoComplete}
      type={opts.type || 'text'}
      // A tel field gets the numeric keypad AND a pattern, which both improve
      // the browser's own field classification, and its value is filtered so a
      // mis-targeted autofill never reaches state.
      inputMode={opts.type === 'tel' ? 'tel' : undefined}
      pattern={opts.type === 'tel' ? '[0-9+()\\-.\\s]*' : undefined}
      // password managers are the other common source of a wrong fill
      data-lpignore={opts.type === 'tel' ? 'true' : undefined}
      data-1p-ignore={opts.type === 'tel' ? 'true' : undefined}
      value={value}
      onChange={e => onChange(opts.type === 'tel' ? sanitizePhoneInput(e.target.value) : e.target.value)}
      placeholder={opts.placeholder}
      disabled={opts.disabled}
      maxLength={opts.maxLength}
      style={{
        width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8,
        padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none',
        background: opts.disabled ? '#f5f5f5' : '#fff',
        color: opts.disabled ? '#999' : DARK,
      }}
    />
  )
}

// htmlFor links the label to the input by id (matching inp()'s id={opts.name})
// — another signal browsers use to classify a field, reinforcing name/
// autoComplete rather than replacing them.
function FormField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label htmlFor={htmlFor} style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>
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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProfilePage() {
  // The live "currently selected" location — used ONLY to detect a switch and
  // trigger a reset/refetch below. Never read at save time (that would
  // reintroduce the stale-intent bug the write-scope fix closes); saves use
  // `restaurant`/`discoProfile`, captured from this page's own load fetch.
  const { ref: selectedRestaurantRef } = useSelectedRestaurant()
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)

  // Disco-native profile card (Neon-backed; pre-populated from onboarding).
  const [discoProfile, setDiscoProfile] = useState<DiscoProfile>({ restaurantName: '', phone: '', address: '', addressLine2: '', logoUrl: '', iconUrl: '' })
  const [discoSaving, setDiscoSaving] = useState(false)
  const [discoSuccess, setDiscoSuccess] = useState('')
  const [discoError, setDiscoError] = useState('')
  // Per-field upload spinners for the two images (Logo + Marketplace Image).
  const [discoLogoUploading, setDiscoLogoUploading] = useState(false) // Marketplace Image
  const [discoIconUploading, setDiscoIconUploading] = useState(false) // Logo

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

  // Address state — populated from FM and reused by the FM-backed payload below
  // (Profile + DoorDash cards). No standalone "Address" card anymore.
  const [address, setAddress] = useState<Address>({ businessName: '', phoneNumber: '', addressLine1: '', city: '', state: '', zipcode: '' })

  // DoorDash card state
  const [pickupInstructions, setPickupInstructions] = useState('')
  const [ddSaving, setDdSaving] = useState(false)
  const [ddSuccess, setDdSuccess] = useState('')
  const [ddError, setDdError] = useState('')

  // Restaurant Images card (Logo + Marketplace Image) — Neon-backed save state.
  const [imgSaving, setImgSaving] = useState(false)
  const [imgError, setImgError] = useState('')
  const [imgSuccess, setImgSuccess] = useState('')

  const [loading, setLoading] = useState(true)

  // Stripe Connect status — drives the "connect your bank" warning banner.
  // null = unknown/loading; false = not connected (show banner).
  const [stripeConnected, setStripeConnected] = useState<boolean | null>(null)
  const [connectingStripe, setConnectingStripe] = useState(false)
  const [stripeError, setStripeError] = useState('')
  // Captured from the SAME stripe-status response that drives the banner above —
  // guaranteed present by the time the button is clickable, unlike `restaurant`
  // (a separate, independently-timed fetch that could still be in flight).
  const [stripeRef, setStripeRef] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/restaurant/stripe-status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) { setStripeConnected(!!d?.connected); setStripeRef(d?.restaurant_reference || '') } })
      .catch(() => { if (!cancelled) setStripeConnected(null) })
    return () => { cancelled = true }
  }, [])

  // Start Stripe Connect onboarding (same route the Banking page uses) and
  // redirect to the returned hosted URL.
  async function connectStripe() {
    setConnectingStripe(true)
    setStripeError('')
    try {
      const ref = encodeURIComponent(stripeRef)
      const res = await fetch(`/api/restaurant/stripe/connect?restaurant_reference=${ref}`, { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (res.ok && d?.stripeConnectUrl) { window.location.href = d.stripeConnectUrl; return }
      setStripeError(d?.error || 'Could not start Stripe Connect. Please try again.')
    } catch {
      setStripeError('Network error. Please try again.')
    }
    setConnectingStripe(false)
  }

  // Reloads every section of this page from scratch — used for the initial
  // mount AND to reset the page when the selected restaurant changes
  // underneath it (see the effect below), so a stale form never keeps
  // showing a different location's data after a switch.
  function loadProfileData() {
    setLoading(true)
    Promise.all([
      fetch('/api/restaurant/profile').then(r => r.ok ? r.json() : null),
      fetch('/api/restaurant/disco-profile').then(r => r.ok ? r.json() : null),
      fetch('/api/restaurant/account-profile').then(r => r.ok ? r.json() : null),
    ]).then(([rest, disco, acct]) => {
      // Personal profile (name / email / phone) — works for FM AND Disco-native
      // users via /api/restaurant/account-profile. Fall back to the FM restaurant
      // admin block if that endpoint is unavailable.
      if (acct) {
        setAdmin({
          firstName: acct.firstName || '',
          lastName: acct.lastName || '',
          email: acct.email || '',
          phoneNumber: acct.phoneNumber || '',
        })
      } else if (rest?.admin) {
        setAdmin({
          firstName: rest.admin?.firstName || '',
          lastName: rest.admin?.lastName || '',
          email: rest.admin?.email || '',
          phoneNumber: rest.admin?.phoneNumber || '',
        })
      }
      if (rest) {
        setRestaurant(rest)
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
      if (disco) {
        setDiscoProfile({
          restaurantName: disco.restaurantName || '',
          phone: disco.phone || '',
          address: disco.address || '',
          addressLine2: disco.addressLine2 || '',
          logoUrl: disco.logoUrl || '',
          iconUrl: disco.iconUrl || '',
        })
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { loadProfileData() }, [])

  // Reset when the SA switches to a different location so this page never
  // keeps showing stale data for the location it was originally loaded for.
  const mountedSelectionRef = useRef(false)
  useEffect(() => {
    if (!mountedSelectionRef.current) { mountedSelectionRef.current = true; return }
    loadProfileData()
  }, [selectedRestaurantRef])

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
        phoneNumber: sanitizePhoneInput(admin.phoneNumber),
      },
      address: {
        businessName: address.businessName,
        phoneNumber: sanitizePhoneInput(address.phoneNumber),
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

  // Personal profile — saved via /api/restaurant/account-profile, which routes to
  // disco_restaurant_accounts (Disco-native) or FM /api/users (FM-native). Email
  // is intentionally not changed here.
  async function saveProfile() {
    setProfileSaving(true)
    setProfileError('')
    setProfileSuccess('')
    try {
      const res = await fetch('/api/restaurant/account-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: admin.firstName,
          lastName: admin.lastName,
          phoneNumber: sanitizePhoneInput(admin.phoneNumber),
        }),
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

  // Disco-native restaurant info — saved to Neon (accounts + cache), not FM.
  async function saveDiscoProfile() {
    setDiscoSaving(true)
    setDiscoError('')
    setDiscoSuccess('')
    try {
      const res = await fetch('/api/restaurant/disco-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...discoProfile, restaurant_reference: restaurant?.reference || '' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        // Surface the write-scope gate's real message (e.g. a stale/foreign
        // restaurant_reference) instead of a generic failure — and reload so
        // the form re-points at whatever location is actually selected now.
        setDiscoError(d?.error || 'Failed to save. Please try again.')
        if (res.status === 400 || res.status === 403 || res.status === 409) loadProfileData()
      } else {
        const d = await res.json().catch(() => null)
        setDiscoSuccess(d && d.located === false
          ? 'Restaurant info updated — but we couldn’t place this address on the map. Please check it.'
          : 'Restaurant info updated.')
        setTimeout(() => setDiscoSuccess(''), d && d.located === false ? 8000 : 3000)
      }
    } catch {
      setDiscoError('Network error. Please try again.')
    }
    setDiscoSaving(false)
  }

  // Image upload → Vercel Blob; the URL is saved on "Save". `which` selects the
  // target: 'logo' → iconUrl (icon_url); 'marketplace' → logoUrl (image_url).
  // Reuses the onboarding endpoint so both flows behave identically.
  async function uploadDiscoImage(file: File, which: 'logo' | 'marketplace') {
    const setUploading = which === 'logo' ? setDiscoIconUploading : setDiscoLogoUploading
    setUploading(true)
    setImgError('')
    try {
      const fd = new FormData()
      fd.append('image', file)
      const res = await fetch('/api/become-a-partner/logo', { method: 'POST', body: fd })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.url) {
        const url = String(data.url)
        setDiscoProfile(p => (which === 'logo' ? { ...p, iconUrl: url } : { ...p, logoUrl: url }))
      } else {
        setImgError(data?.error || 'Could not upload image.')
      }
    } catch {
      setImgError('Could not upload image.')
    } finally {
      setUploading(false)
    }
  }

  // Persist both images (icon_url + image_url) via the disco-profile PUT.
  async function saveDiscoImages() {
    setImgSaving(true)
    setImgError('')
    setImgSuccess('')
    try {
      // Send the full profile so the PUT doesn't null phone/address (it sets them
      // from the body); discoProfile holds the loaded values + both image URLs.
      const res = await fetch('/api/restaurant/disco-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...discoProfile, restaurant_reference: restaurant?.reference || '' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        setImgError(d?.error || 'Failed to save images. Please try again.')
        if (res.status === 400 || res.status === 403 || res.status === 409) loadProfileData()
      } else {
        setImgSuccess('Images updated.')
        setTimeout(() => setImgSuccess(''), 3000)
      }
    } catch {
      setImgError('Network error. Please try again.')
    }
    setImgSaving(false)
  }

  async function saveDoorDash() {
    setDdSaving(true)
    setDdError('')
    setDdSuccess('')
    try {
      // Pre-save guard (WARN only, never block): this PUT hits FM's updateRestaurant,
      // which re-validates and auto-disables online ordering if the restaurant is
      // missing a complete address, a contact phone, or a connected Stripe account.
      // The restaurant's own session can read its notification phone, so the contact
      // check is fully accurate here.
      let notificationPhones: string[] = []
      try {
        const n = await fetch('/api/restaurant/notifications').then(r => r.ok ? r.json() : null)
        if (Array.isArray(n?.phoneNumber)) notificationPhones = n.phoneNumber
      } catch { /* best-effort — fall back to admin-phone-only contact check */ }
      const chk = checkOrderingWouldDisable({
        onlineOrderingAllowed: (restaurant as { onlineOrderingAllowed?: boolean } | null)?.onlineOrderingAllowed,
        address,
        adminPhone: admin.phoneNumber,
        notificationPhones,
        stripeConnected,
        canCheckContactFully: true,
      })
      if (chk.wouldDisable && typeof window !== 'undefined' && !window.confirm(chk.message!)) {
        setDdSaving(false)
        return
      }

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

  if (loading) {
    return (
      <div className="dc-page-pad" style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }

  const isDoorDash = restaurant?.deliveryType === 'DOOR_DASH_DELIVERY'

  return (
    <div className="dc-page-pad" style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
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
          {stripeError && (
            <div style={{ width: '100%', fontSize: 12, color: '#9A3412', marginTop: -4 }}>{stripeError}</div>
          )}
        </div>
      )}
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 24px' }}>Profile</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(440px, 100%), 1fr))', gap: 20, alignItems: 'start' }}>
        {/* Card 1: Personal Info */}
        <Card title="Profile" onSave={saveProfile} saving={profileSaving} success={profileSuccess} error={profileError}>
          <FormField label="First Name" htmlFor="admin-first-name">
            {inp(admin.firstName, v => setAdmin({ ...admin, firstName: v }), { name: 'admin-first-name', autoComplete: 'given-name' })}
          </FormField>
          <FormField label="Last Name" htmlFor="admin-last-name">
            {inp(admin.lastName, v => setAdmin({ ...admin, lastName: v }), { name: 'admin-last-name', autoComplete: 'family-name' })}
          </FormField>
          <FormField label="Email" htmlFor="admin-email">
            {inp(admin.email, () => {}, { disabled: true, type: 'email', name: 'admin-email', autoComplete: 'email' })}
            {/* Two things, because this box is the only Email field most restaurants ever
                see and it does NOT route anything. It shows the LOGIN address, and order
                notifications go to a different screen entirely (Settings → Email
                Notification Recipients → disco_restaurant_overrides.notification_emails).
                Without the second line a restaurant can reasonably assume changing this
                would redirect their orders — it would not, and it cannot, because the
                field is disabled and saveProfile() never sends it. */}
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>
              This is your login email. To change it, contact concierge@discocater.com.
            </div>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>
              Order notifications go somewhere else — set those under Settings → Email Notification Recipients.
            </div>
          </FormField>
          <FormField label="Phone Number" htmlFor="admin-phone-number">
            {inp(admin.phoneNumber, v => setAdmin({ ...admin, phoneNumber: v }), { type: 'tel', name: 'admin-phone-number', autoComplete: 'tel' })}
          </FormField>
        </Card>

        {/* Card 2: Change Password */}
        <Card title="Change Password" onSave={savePassword} saving={pwSaving} success={pwSuccess} error={pwError}>
          <FormField label="Current Password" htmlFor="current-password">
            {inp(password, setPassword, { type: 'password', name: 'current-password', autoComplete: 'current-password' })}
          </FormField>
          <FormField label="New Password" htmlFor="new-password">
            {inp(newPassword, setNewPassword, { type: 'password', name: 'new-password', autoComplete: 'new-password' })}
          </FormField>
        </Card>

        {/* Card 3: Restaurant Info (Disco-native; pre-populated from onboarding,
            saved to Neon — not synced to FM) */}
        <Card title="Restaurant Info" onSave={saveDiscoProfile} saving={discoSaving} success={discoSuccess} error={discoError}>
          <FormField label="Restaurant Name" htmlFor="restaurant-name">
            {inp(discoProfile.restaurantName, v => setDiscoProfile({ ...discoProfile, restaurantName: v }), { name: 'restaurant-name', autoComplete: 'organization' })}
          </FormField>
          <FormField label="Phone Number" htmlFor="restaurant-phone-number">
            {inp(discoProfile.phone, v => setDiscoProfile({ ...discoProfile, phone: v }), { type: 'tel', name: 'restaurant-phone-number', autoComplete: 'tel' })}
          </FormField>
          {/* Single free-text line (street + city/state/zip combined, per the
              placeholder below) — 'street-address' is the spec token for a
              combined single-field address, distinct from the split
              address-line1/address-line2/address-level2 tokens; there's no
              other address field on this form for it to conflict with. */}
          <FormField label="Address" htmlFor="restaurant-address">
            {inp(discoProfile.address, v => setDiscoProfile({ ...discoProfile, address: v }), { placeholder: 'Street, City, State ZIP', name: 'restaurant-address', autoComplete: 'street-address' })}
          </FormField>
          {/* Optional. Shown wherever the address appears — customer pages,
              link pages, order emails, PDFs and courier pickups. autoComplete
              off so a browser doesn't split the combined box above. */}
          <FormField label="Address line 2 (optional)" htmlFor="restaurant-address-line2">
            {inp(discoProfile.addressLine2, v => setDiscoProfile({ ...discoProfile, addressLine2: v }), { placeholder: 'Suite, unit, floor', name: 'restaurant-address-line2', autoComplete: 'off' })}
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

        {/* Card 6: Restaurant Images (Disco-native; Neon-backed icon_url + image_url) */}
        <Card title="Restaurant Images" onSave={saveDiscoImages} saving={imgSaving} success={imgSuccess} error={imgError}>
          {/* Logo — small square icon → disco_restaurant_cache.icon_url */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 8 }}>
              Logo
            </label>
            {discoProfile.iconUrl && (
              <div style={{ position: 'relative', width: 100, marginBottom: 10 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={discoProfile.iconUrl} alt="Logo"
                  style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 8, border: '1px solid #eee', display: 'block' }} />
                {!discoIconUploading && (
                  // Staged: '' → icon_url NULL via the disco-profile PUT on Save.
                  <button type="button" onClick={() => setDiscoProfile(p => ({ ...p, iconUrl: '' }))} aria-label="Remove image" title="Remove image" style={removeImageX}>×</button>
                )}
              </div>
            )}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#fff', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, cursor: discoIconUploading ? 'default' : 'pointer', fontFamily: F, color: DARK }}>
              {discoIconUploading ? 'Uploading…' : (discoProfile.iconUrl ? 'Replace Image' : 'Upload Image')}
              <input type="file" accept="image/*" disabled={discoIconUploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadDiscoImage(f, 'logo') }}
                style={{ display: 'none' }} />
            </label>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>Small square icon — your restaurant logo. Click Save to apply.</div>
          </div>

          {/* Marketplace Image — wider hero photo → disco_restaurant_cache.image_url */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 8 }}>
              Marketplace Image
            </label>
            {discoProfile.logoUrl && (
              <div style={{ position: 'relative', width: 150, marginBottom: 10 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={discoProfile.logoUrl} alt="Marketplace"
                  style={{ width: 150, height: 113, objectFit: 'cover', borderRadius: 8, border: '1px solid #eee', display: 'block' }} />
                {!discoLogoUploading && (
                  // Staged: '' → image_url NULL via the disco-profile PUT on Save.
                  <button type="button" onClick={() => setDiscoProfile(p => ({ ...p, logoUrl: '' }))} aria-label="Remove image" title="Remove image" style={removeImageX}>×</button>
                )}
              </div>
            )}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#fff', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, cursor: discoLogoUploading ? 'default' : 'pointer', fontFamily: F, color: DARK }}>
              {discoLogoUploading ? 'Uploading…' : (discoProfile.logoUrl ? 'Replace Image' : 'Upload Image')}
              <input type="file" accept="image/*" disabled={discoLogoUploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadDiscoImage(f, 'marketplace') }}
                style={{ display: 'none' }} />
            </label>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>Wider hero photo shown on the catering map listing. Click Save to apply.</div>
          </div>
        </Card>
      </div>
    </div>
  )
}
