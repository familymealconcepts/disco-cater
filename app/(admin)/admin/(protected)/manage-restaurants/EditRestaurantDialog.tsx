'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { checkOrderingWouldDisable } from '../../../../../lib/ordering-validation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GRADIENT = 'linear-gradient(90deg, #6B6EF9, #C044C8, #F0468A)'

// Cuisine options for the multi-select checklist (up to 3). Canonical list; any
// loaded value not in it is merged in below so a non-listed value (e.g. an
// enrichment cuisine like "Tacos") is never silently dropped. Stored as a
// comma-separated string in disco_restaurant_cache.cuisine.
const CUISINES = ['BBQ', 'Bagels', 'Bakery', 'Bar & Grill', 'Bowls', 'Boxed Lunches', 'Breakfast', 'Burgers', 'Burritos', 'Cafe', 'Caribbean', 'Chicken', 'Deli', 'Chinese', 'French', 'Greek', 'Indian', 'Italian', 'Japanese', 'Korean', 'Latin', 'Mediterranean', 'Mexican', 'Middle Eastern', 'Pizza', 'Sandwiches', 'Seafood', 'Soul Food', 'Sushi', 'Tacos', 'Thai', 'Vegan', 'Vietnamese']
const MAX_CUISINES = 3

interface FmAddress { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zipcode?: string; phoneNumber?: string; latitude?: number; longitude?: number }
interface FmRestaurant {
  reference: string
  businessName?: string
  businessNameWithoutSpaces?: string
  address?: FmAddress
  admin?: { firstName?: string; lastName?: string; email?: string; phoneNumber?: string }
  onlineOrderingAllowed?: boolean
  categories?: string[]
  fulfillmentOptions?: string[]
  timezone?: string
  leadGenOne?: number
  leadGenTwo?: number
  image?: { reference?: string }
}

interface CacheRow {
  cuisine?: string | null
  description?: string | null
  location?: string | null
  lat?: string | number | null
  lng?: string | number | null
  image_url?: string | null
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

// Read-only URL row with a clipboard copy button (used by the Order URLs
// section). Manages its own transient "Copied ✓" state.
function CopyRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 5 }}>{label}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input readOnly value={url} onFocus={e => e.currentTarget.select()}
          style={{ flex: 1, padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 12.5, fontFamily: F, color: '#555', background: '#fafafa', outline: 'none', boxSizing: 'border-box' }} />
        <button type="button"
          onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {} }}
          style={{ background: '#EEF0FD', border: '1.5px solid #c8cafd', color: '#3A3DB0', borderRadius: 8, padding: '9px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export default function EditRestaurantDialog({ restaurantRef, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [savedOk, setSavedOk] = useState(false)
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

  // Map fields (Neon disco_restaurant_cache — the public fullmap reads these)
  const [cuisines, setCuisines] = useState<string[]>([])
  // Admin-managed cuisine types (disco_cuisine_types) — loaded from the API so
  // super-admin additions show up here and on the fullmap. Falls back to the
  // canonical seed list (CUISINES) until/if the fetch resolves.
  const [cuisineTypes, setCuisineTypes] = useState<string[]>(CUISINES)
  const [addingCuisine, setAddingCuisine] = useState(false)
  const [newCuisine, setNewCuisine] = useState('')
  const [addCuisineBusy, setAddCuisineBusy] = useState(false)
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [imageUrl, setImageUrl] = useState('')        // current/uploaded CDN URL
  const [imageFile, setImageFile] = useState<File | null>(null) // new file → also pushed to FM
  const [uploadingImage, setUploadingImage] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)

  // Overrides (Neon disco_restaurant_overrides)
  const [isDisco, setIsDisco] = useState(false)
  const [visible, setVisible] = useState(false)
  // Order-URL override is no longer editable here, but we round-trip the loaded
  // value on save so the overrides PATCH (which overwrites order_url) doesn't
  // wipe it.
  const [orderUrlOverride, setOrderUrlOverride] = useState('')
  const [stripeConnected, setStripeConnected] = useState<boolean | null>(null)

  // Payout schedule (M9) — Disco-native only. Loaded from the restaurant's Stripe
  // connected account; saved independently of the FM Submit.
  const [payoutApplicable, setPayoutApplicable] = useState<boolean | null>(null)
  const [payoutReason, setPayoutReason] = useState('')
  const [payoutInterval, setPayoutInterval] = useState<'manual' | 'daily' | 'weekly' | 'monthly'>('weekly')
  const [weeklyAnchor, setWeeklyAnchor] = useState('monday')
  const [monthlyAnchor, setMonthlyAnchor] = useState('1')
  const [delayDays, setDelayDays] = useState('2')
  const [payoutSaving, setPayoutSaving] = useState(false)
  const [payoutErr, setPayoutErr] = useState('')
  const [payoutSavedOk, setPayoutSavedOk] = useState(false)

  // FM→Disco-native conversion (M3) — shown for FM-backed restaurants.
  interface ConvStep { key: string; label: string; done: boolean; blocking: boolean; detail: string }
  const [conv, setConv] = useState<null | { found: boolean; isDiscoNative: boolean; ready: boolean; ordersMirrored: number; steps: ConvStep[] }>(null)
  const [convBusy, setConvBusy] = useState(false)
  const [convMsg, setConvMsg] = useState('')
  const [convErr, setConvErr] = useState('')

  // FM menu-drift status (Task: menu drift visibility) — shown for Disco-native
  // restaurants only. Read-only status + an on-demand "check now" / "re-baseline".
  interface DriftDetail { type: string; reference: string; name: string; before?: string | number; after?: string | number }
  const [drift, setDrift] = useState<null | { hasBaseline: boolean; hasDrift: boolean; details: DriftDetail[]; lastCheckedAt: string | null; baselineCapturedAt: string | null }>(null)
  const [driftBusy, setDriftBusy] = useState(false)
  const [driftMsg, setDriftMsg] = useState('')
  const [driftErr, setDriftErr] = useState('')

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
      fetch(`/api/admin/restaurant-cache?restaurantReference=${restaurantRef}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/admin/restaurant-overrides?restaurantReference=${restaurantRef}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([fm, cache, ov]: [FmRestaurant | null, CacheRow | null, { isPremium?: boolean; visible?: boolean; orderUrl?: string; stripeConnected?: boolean } | null]) => {
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
      // Map fields from Neon cache.
      if (cache) {
        setCuisines((cache.cuisine || '').split(',').map(s => s.trim()).filter(Boolean))
        setDescription(cache.description || '')
        setLocation(cache.location || '')
        setLat(cache.lat != null ? String(cache.lat) : '')
        setLng(cache.lng != null ? String(cache.lng) : '')
        setImageUrl(cache.image_url || '')
      }
      // Premium + map visibility + order-URL override come from Neon overrides.
      if (ov) {
        setIsDisco(!!ov.isPremium)
        setVisible(!!ov.visible)
        setOrderUrlOverride(ov.orderUrl || '')
        setStripeConnected(typeof ov.stripeConnected === 'boolean' ? ov.stripeConnected : null)
      }
    }).catch(() => { if (!cancel) setErr('Failed to load restaurant') })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [restaurantRef])

  // Load the Disco-native payout schedule (no-op / not-applicable for FM-backed).
  useEffect(() => {
    let cancel = false
    fetch(`/api/admin/restaurants/${restaurantRef}/payout-schedule`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { applicable?: boolean; reason?: string; schedule?: { interval: string; weeklyAnchor: string | null; monthlyAnchor: number | null; delayDays: number | null } } | null) => {
        if (cancel || !d) return
        setPayoutApplicable(!!d.applicable)
        setPayoutReason(d.reason || '')
        if (d.applicable && d.schedule) {
          const s = d.schedule
          if (['manual', 'daily', 'weekly', 'monthly'].includes(s.interval)) setPayoutInterval(s.interval as 'manual' | 'daily' | 'weekly' | 'monthly')
          if (s.weeklyAnchor) setWeeklyAnchor(s.weeklyAnchor)
          if (s.monthlyAnchor != null) setMonthlyAnchor(String(s.monthlyAnchor))
          if (s.delayDays != null) setDelayDays(String(s.delayDays))
        }
      })
      .catch(() => { if (!cancel) setPayoutApplicable(false) })
    return () => { cancel = true }
  }, [restaurantRef])

  async function savePayoutSchedule() {
    setPayoutErr(''); setPayoutSavedOk(false); setPayoutSaving(true)
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantRef}/payout-schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interval: payoutInterval,
          weeklyAnchor: payoutInterval === 'weekly' ? weeklyAnchor : undefined,
          monthlyAnchor: payoutInterval === 'monthly' ? Number(monthlyAnchor) : undefined,
          delayDays: payoutInterval === 'manual' ? undefined : Number(delayDays),
        }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Could not update payout schedule')
      if (d?.schedule) {
        const s = d.schedule
        if (s.weeklyAnchor) setWeeklyAnchor(s.weeklyAnchor)
        if (s.monthlyAnchor != null) setMonthlyAnchor(String(s.monthlyAnchor))
        if (s.delayDays != null) setDelayDays(String(s.delayDays))
      }
      setPayoutSavedOk(true)
      setTimeout(() => setPayoutSavedOk(false), 2500)
    } catch (e) {
      setPayoutErr(e instanceof Error ? e.message : 'Could not update payout schedule')
    } finally {
      setPayoutSaving(false)
    }
  }

  // Load the FM→native conversion readiness (checklist). No-op for native restaurants.
  const loadConversion = useCallback(() => {
    fetch(`/api/admin/restaurants/${restaurantRef}/convert-native`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && !d.error) setConv(d) })
      .catch(() => {})
  }, [restaurantRef])
  useEffect(() => { loadConversion() }, [loadConversion])

  async function convertToNative() {
    if (typeof window !== 'undefined' && !window.confirm('Convert this restaurant to Disco-native? Its checkout, menus, and payouts will be managed entirely in Disco. Marketplace visibility is preserved by the drop-off guard.')) return
    setConvBusy(true); setConvErr(''); setConvMsg('')
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantRef}/convert-native`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.converted) throw new Error(d?.reason || d?.error || 'Conversion failed')
      if (d.readiness) setConv(d.readiness)
      setConvMsg('Converted to Disco-native.')
    } catch (e) {
      setConvErr(e instanceof Error ? e.message : 'Conversion failed')
    } finally {
      setConvBusy(false)
    }
  }

  // Load the stored FM menu-drift status (cheap — no FM call). No-op for
  // non-native restaurants (the route just returns hasBaseline: false).
  const loadDrift = useCallback(() => {
    fetch(`/api/admin/restaurants/${restaurantRef}/menu-drift`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && !d.error) setDrift(d) })
      .catch(() => {})
  }, [restaurantRef])
  useEffect(() => { loadDrift() }, [loadDrift])

  async function checkMenuDriftNow() {
    setDriftBusy(true); setDriftErr(''); setDriftMsg('')
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantRef}/menu-drift`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.checked) throw new Error(d?.error || 'Drift check failed')
      setDrift({ hasBaseline: true, hasDrift: d.hasDrift, details: d.details || [], lastCheckedAt: new Date().toISOString(), baselineCapturedAt: d.baselineCapturedAt })
      setDriftMsg(d.hasDrift ? `${d.details.length} change(s) found.` : 'No changes — FM menu matches the native menu.')
    } catch (e) {
      setDriftErr(e instanceof Error ? e.message : 'Drift check failed')
    } finally {
      setDriftBusy(false)
    }
  }

  async function reBaselineMenuDrift() {
    if (typeof window !== 'undefined' && !window.confirm("Re-baseline against FM's current menu? This accepts the current FM state as the new normal — future checks compare against it, not today's changes.")) return
    setDriftBusy(true); setDriftErr(''); setDriftMsg('')
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantRef}/menu-drift`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.ok) throw new Error(d?.error || 'Re-baseline failed')
      setDrift({ hasBaseline: true, hasDrift: false, details: [], lastCheckedAt: new Date().toISOString(), baselineCapturedAt: new Date().toISOString() })
      setDriftMsg('Re-baselined against current FM menu.')
    } catch (e) {
      setDriftErr(e instanceof Error ? e.message : 'Re-baseline failed')
    } finally {
      setDriftBusy(false)
    }
  }

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // New map image: upload to the asset CDN immediately so we have a URL to
  // preview + save; keep the raw file to also push to FM's marketplace logo.
  async function onImageSelected(f: File | null) {
    setImageFile(f)
    if (!f) return
    setUploadingImage(true); setErr('')
    try {
      const fd = new FormData(); fd.append('file', f)
      const res = await fetch('/api/admin/upload-asset', { method: 'POST', body: fd })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.url) throw new Error(d?.error || 'Image upload failed')
      setImageUrl(d.url)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Image upload failed')
      setImageFile(null)
      if (imageInputRef.current) imageInputRef.current.value = ''
    } finally {
      setUploadingImage(false)
    }
  }

  // Clear the map image (× on the preview). Persistence note: the cache PATCH
  // COALESCEs image_url, so an empty value leaves the stored image unchanged —
  // clearing here removes it from the form/preview and stops a re-upload.
  function clearImage() {
    setImageUrl('')
    setImageFile(null)
    if (imageInputRef.current) imageInputRef.current.value = ''
  }

  function toggleCuisine(c: string) {
    setCuisines(prev =>
      prev.includes(c) ? prev.filter(x => x !== c) : (prev.length >= MAX_CUISINES ? prev : [...prev, c])
    )
  }

  // Load the admin-managed cuisine list (super-admin additions included).
  useEffect(() => {
    let cancel = false
    fetch('/api/admin/cuisine-types')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancel && Array.isArray(d?.cuisineTypes) && d.cuisineTypes.length) setCuisineTypes(d.cuisineTypes) })
      .catch(() => {})
    return () => { cancel = true }
  }, [])

  // Super admin adds a new cuisine type permanently, then auto-selects it here.
  async function addCuisineType() {
    const raw = newCuisine.trim()
    if (!raw || addCuisineBusy) return
    setAddCuisineBusy(true)
    try {
      const res = await fetch('/api/admin/cuisine-types', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: raw }),
      })
      const d = await res.json().catch(() => null)
      if (res.ok && d) {
        if (Array.isArray(d.cuisineTypes)) setCuisineTypes(d.cuisineTypes)
        // Auto-check the new cuisine for this restaurant (respecting the 3 max).
        const added: string = d.added || raw
        setCuisines(prev => prev.includes(added) ? prev : (prev.length >= MAX_CUISINES ? prev : [...prev, added]))
        setNewCuisine(''); setAddingCuisine(false)
      } else {
        setErr(d?.error || 'Could not add cuisine type')
      }
    } catch {
      setErr('Could not add cuisine type')
    } finally {
      setAddCuisineBusy(false)
    }
  }

  async function submit() {
    setErr('')
    setSavedOk(false)
    // Admin fields are optional. FM only requires an email when a name is
    // provided (INVALID_ADMIN_EMAIL_IF_NAME_PROVIDED) — mirror that here.
    if ((firstName.trim() || lastName.trim()) && !email.trim()) return setErr('Email is required when a name is provided')
    if (!addr1.trim()) return setErr('Address line 1 is required')

    // Pre-save guard (WARN only, never block): this save re-triggers FM's ordering
    // validation, which auto-disables online ordering when a restaurant is missing a
    // complete address or a contact phone. The admin can't see the notification phone,
    // so the contact check may over-warn (acceptable). Stripe only flags on a
    // confident "not connected" to avoid stale false positives.
    const chk = checkOrderingWouldDisable({
      onlineOrderingAllowed: existing?.onlineOrderingAllowed,
      address: { addressLine1: addr1, city, state: stateVal, zipcode, latitude: existing?.address?.latitude ?? null, longitude: existing?.address?.longitude ?? null },
      adminPhone: existing?.admin?.phoneNumber,
      notificationPhones: undefined,
      stripeConnected: stripeConnected !== false,
      canCheckContactFully: false,
    })
    if (chk.wouldDisable && typeof window !== 'undefined' && !window.confirm(chk.message!)) return

    setSaving(true)
    try {
      // 1) FM core fields.
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
      if (!putRes.ok) {
        // Surface FM's actual rejection (the route returns it in `raw`) instead of a
        // bare "Failed to save restaurant" that hides the real cause.
        const d = await putRes.json().catch(() => null)
        const rawDetail = d?.raw ? (typeof d.raw === 'string' ? d.raw : JSON.stringify(d.raw)) : ''
        throw new Error(rawDetail ? `FM rejected the save (${putRes.status}): ${rawDetail.slice(0, 500)}` : (d?.error || `Failed to save restaurant (${putRes.status})`))
      }

      // 2) Premium + visibility → Neon overrides (order_url round-tripped, not edited here).
      const ovRes = await fetch('/api/admin/restaurant-overrides', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantReference: restaurantRef, isPremium: isDisco, visible, orderUrl: orderUrlOverride || undefined }),
      })
      if (!ovRes.ok) throw new Error('Saved restaurant, but the Premium / visibility override failed to save')

      // 3) Push the new map image to FM's marketplace logo too (FM side still needs it).
      if (imageFile) {
        const fd = new FormData(); fd.append('file', imageFile)
        await fetch(`/api/admin/restaurants/${restaurantRef}/marketplace-image`, { method: 'POST', body: fd })
      }

      // 4) Map fields → Neon disco_restaurant_cache (source of truth for the fullmap).
      const cacheRes = await fetch('/api/admin/restaurant-cache', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantReference: restaurantRef,
          name: restaurantName.trim() || undefined, // for the upsert when no cache row exists yet
          cuisine: cuisines.length ? cuisines.join(', ') : null,
          description: description || null,
          location: location || null,
          lat: lat || null,
          lng: lng || null,
          // Send the raw value: "" (after ×) explicitly clears it server-side;
          // a URL sets it. (Route treats "" → NULL, undefined → keep.)
          image_url: imageUrl,
        }),
      })
      if (!cacheRes.ok) {
        const d = await cacheRes.json().catch(() => null)
        throw new Error(d?.error || 'Saved restaurant, but the map fields failed to save')
      }

      setSavedOk(true)
      // Close the dialog immediately on success. The parent's onSaved handler
      // dismisses it (setEditRef(null)), shows a toast, and reloads the list.
      onSaved('Restaurant updated')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to save')
    } finally {
      setSaving(false)
    }
  }

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 5 }
  const input: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', boxSizing: 'border-box' }
  const section: React.CSSProperties = { border: '1px solid #eee', borderRadius: 12, padding: '18px 20px', background: '#fff', marginBottom: 14 }
  const sTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: DARK, marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.04em' }
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }

  // Public slug for both ordering URLs = FM businessNameWithoutSpaces, lowercased.
  const slug = (existing?.businessNameWithoutSpaces || '').toLowerCase()
  // Checklist options — admin-managed list (falls back to the seed) plus any
  // already-assigned values not in it, so nothing is silently dropped.
  const cuisineOptions = Array.from(new Set([...cuisineTypes, ...cuisines])).sort()

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
                  <div><label style={label}>First name</label><input style={input} value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
                  <div><label style={label}>Last name</label><input style={input} value={lastName} onChange={e => setLastName(e.target.value)} /></div>
                </div>
                <div style={{ marginBottom: 12 }}><label style={label}>Restaurant name</label><input style={input} value={restaurantName} onChange={e => setRestaurantName(e.target.value)} /></div>
                <div style={grid2}>
                  {/* Explicit type/name/autoComplete on every field — a plain
                      untyped/unnamed input next to a same-shaped sibling is
                      exactly what let a browser drop an autofilled email into
                      this phone field (confirmed live on The Winkin' Rooster). */}
                  {/* READ-ONLY, deliberately, and matching the restaurant's own profile page.
                      This is disco_restaurant_accounts.email — the LOGIN CREDENTIAL — not a
                      contact detail, and it was presented as one with no indication.

                      Editing it here could not do the job even when it worked. A login move
                      also has to carry disco_restaurant_sessions.email and
                      disco_restaurant_location_access.account_email (both keyed on the address
                      as TEXT, both orphaned by a bare UPDATE), leave disco_admin_audit.actor_email
                      alone, check merge-vs-rename against the UNIQUE constraint, and end with a
                      fresh invite so somebody can actually sign in afterwards. This dialog did one
                      UPDATE. The failure mode is a restaurant locked out, discovered whenever they
                      next try to log in.

                      It was also scoped WHERE restaurant_reference = ref, which matches EVERY
                      anchored row — 9 at Atlanta Bread – Asheville — so on the nine multi-account
                      restaurants it set them all to one address and 409'd against itself with
                      "already used by another account".

                      Credential changes go through concierge: deliberate, verified, evidenced. */}
                  <div>
                    <label style={label}>Login email</label>
                    <input style={{ ...input, background: '#f4f4f8', color: '#777' }} type="email" name="admin-email" autoComplete="email" value={email} disabled readOnly />
                    <div style={{ fontSize: 11, color: '#aaa', marginTop: 5 }}>
                      This is the restaurant&rsquo;s login. To change it, go through concierge@discocater.com — a login move also has to carry their session and location access, and ends with a fresh invite.
                    </div>
                  </div>
                  <div><label style={label}>Phone</label><input style={input} type="tel" name="admin-phone" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} /></div>
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

              {/* Map listing (Neon disco_restaurant_cache) */}
              <div style={section}>
                <div style={sTitle}>Map listing</div>
                <p style={{ fontSize: 12, color: '#777', margin: '0 0 14px' }}>Shown on the Disco Cater fullmap. Saved to Disco (Neon).</p>
                <div style={{ marginBottom: 12 }}>
                  <label style={label}>Location / display text</label>
                  <input style={input} value={location} onChange={e => setLocation(e.target.value)} placeholder="Brooklyn, NY" />
                </div>
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
                <div>
                  <label style={label}>Image</label>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    {imageUrl ? (
                      <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
                        <img src={imageUrl} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid #e0e0e0', display: 'block' }} />
                        <button type="button" onClick={clearImage} aria-label="Remove image"
                          style={{ position: 'absolute', top: -7, right: -7, width: 20, height: 20, borderRadius: '50%', background: '#1A1028', color: '#fff', border: '2px solid #fff', fontSize: 12, lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}>×</button>
                      </div>
                    ) : (
                      <div style={{ width: 64, height: 64, borderRadius: 8, border: '1px dashed #d8d8d8', background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, color: '#ccc', flexShrink: 0 }}>🖼</div>
                    )}
                    <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => onImageSelected(e.target.files?.[0] || null)} />
                    <button type="button" onClick={() => imageInputRef.current?.click()} disabled={uploadingImage}
                      style={{ background: '#EEF0FD', border: '1.5px solid #c8cafd', color: '#3A3DB0', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: uploadingImage ? 'wait' : 'pointer', fontFamily: F, opacity: uploadingImage ? 0.6 : 1 }}>
                      {uploadingImage ? 'Uploading…' : (imageUrl ? 'Upload new image' : 'Upload image')}
                    </button>
                  </div>
                  <p style={{ fontSize: 11, color: '#aaa', margin: '6px 0 0' }}>Shown on the map card. Recommended: landscape, min 800px wide.</p>
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

              {/* Convert to Disco-native (M3) — shown only for FM-backed restaurants.
                  Every blocking step must pass (incl. the M4 marketplace guard). */}
              {conv?.found && !conv.isDiscoNative && (
                <div style={section}>
                  <div style={sTitle}>Convert to Disco-native</div>
                  <p style={{ fontSize: 12, color: '#777', margin: '0 0 12px' }}>Move this FM-backed restaurant onto Disco-native ordering. Each blocking step must pass; marketplace visibility is preserved by the drop-off guard.</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {conv.steps.map(s => (
                      <div key={s.key} style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.4, color: s.done ? '#166534' : (s.blocking ? '#B45309' : '#888') }}>
                        <span style={{ flexShrink: 0, fontWeight: 700 }}>{s.done ? '✓' : (s.blocking ? '✗' : '•')}</span>
                        <span><strong style={{ color: '#333' }}>{s.label}</strong>{s.blocking ? '' : ' (advisory)'} — {s.detail}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#999', margin: '10px 0 12px' }}>{conv.ordersMirrored} order(s) mirrored to Neon. Run a final FM order sync before converting.</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button type="button" onClick={convertToNative} disabled={!conv.ready || convBusy}
                      style={{ background: conv.ready ? '#166534' : '#ccc', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: conv.ready && !convBusy ? 'pointer' : 'not-allowed', fontFamily: F }}>
                      {convBusy ? 'Converting…' : 'Convert to Disco-native'}
                    </button>
                    {convMsg && <span style={{ fontSize: 12, fontWeight: 600, color: '#16A34A' }}>✓ {convMsg}</span>}
                    {convErr && <span style={{ fontSize: 12, color: '#DC2626' }}>{convErr}</span>}
                  </div>
                </div>
              )}

              {/* FM menu drift — Disco-native only. The native menu is a frozen
                  snapshot with no ongoing sync; this surfaces FM-side edits made
                  after conversion so an admin can decide whether to re-import. */}
              {conv?.isDiscoNative && (
                <div style={section}>
                  <div style={sTitle}>FM Menu Drift</div>
                  <p style={{ fontSize: 12, color: '#777', margin: '0 0 12px' }}>
                    This restaurant&apos;s native menu was imported from FM and does not stay in sync — if staff keep editing prices or items on FM&apos;s side, it won&apos;t show up here automatically. A daily check compares FM&apos;s current menu against what was last imported/verified.
                  </p>
                  {drift?.hasDrift ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                      {drift.details.map((d, i) => (
                        <div key={i} style={{ fontSize: 12.5, lineHeight: 1.4, color: '#B45309' }}>
                          {d.type === 'price_changed' && <>Price changed: <strong>{d.name}</strong> ${d.before} → ${d.after}</>}
                          {d.type === 'category_changed' && <>Category changed: <strong>{d.name}</strong> &quot;{d.before}&quot; → &quot;{d.after}&quot;</>}
                          {d.type === 'renamed' && <>Renamed: &quot;{d.before}&quot; → &quot;{d.after}&quot;</>}
                          {d.type === 'added' && <>Added on FM (not in native menu): <strong>{d.name}</strong></>}
                          {d.type === 'removed' && <>Removed on FM (still in native menu): <strong>{d.name}</strong></>}
                        </div>
                      ))}
                    </div>
                  ) : drift?.hasBaseline ? (
                    <div style={{ fontSize: 12.5, color: '#166534', marginBottom: 12 }}>✓ No drift detected{drift.lastCheckedAt ? ` — last checked ${new Date(drift.lastCheckedAt).toLocaleString()}` : ''}.</div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: '#999', marginBottom: 12 }}>Not checked yet.</div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <button type="button" onClick={checkMenuDriftNow} disabled={driftBusy}
                      style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: driftBusy ? 'not-allowed' : 'pointer', fontFamily: F }}>
                      {driftBusy ? 'Checking…' : 'Check for FM drift now'}
                    </button>
                    {drift?.hasDrift && (
                      <button type="button" onClick={reBaselineMenuDrift} disabled={driftBusy}
                        style={{ background: '#fff', color: '#555', border: '1.5px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: driftBusy ? 'not-allowed' : 'pointer', fontFamily: F }}>
                        Accept as new baseline
                      </button>
                    )}
                    {driftMsg && <span style={{ fontSize: 12, fontWeight: 600, color: '#16A34A' }}>✓ {driftMsg}</span>}
                    {driftErr && <span style={{ fontSize: 12, color: '#DC2626' }}>{driftErr}</span>}
                  </div>
                </div>
              )}

              {/* Payout schedule (M9) — Disco-native only; shown when the restaurant
                  has a connected Stripe account. Saved independently of Submit. */}
              {payoutApplicable === true && (
                <div style={section}>
                  <div style={sTitle}>Payout schedule</div>
                  <p style={{ fontSize: 12, color: '#777', margin: '0 0 14px' }}>How often Stripe automatically pays this Disco-native restaurant out to their bank. Saved directly to Stripe.</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={label}>Frequency</label>
                      <select style={{ ...input, cursor: 'pointer' }} value={payoutInterval} onChange={e => setPayoutInterval(e.target.value as 'manual' | 'daily' | 'weekly' | 'monthly')}>
                        <option value="daily">Daily (automatic)</option>
                        <option value="weekly">Weekly (automatic)</option>
                        <option value="monthly">Monthly (automatic)</option>
                        <option value="manual">Manual (no automatic payouts)</option>
                      </select>
                    </div>
                    {payoutInterval === 'weekly' && (
                      <div>
                        <label style={label}>Payout day</label>
                        <select style={{ ...input, cursor: 'pointer' }} value={weeklyAnchor} onChange={e => setWeeklyAnchor(e.target.value)}>
                          {['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => (
                            <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {payoutInterval === 'monthly' && (
                      <div>
                        <label style={label}>Day of month (1–31)</label>
                        <input style={input} type="number" min={1} max={31} value={monthlyAnchor} onChange={e => setMonthlyAnchor(e.target.value)} />
                      </div>
                    )}
                    {payoutInterval !== 'manual' && (
                      <div>
                        <label style={label}>Delay (days)</label>
                        <input style={input} type="number" min={2} max={30} value={delayDays} onChange={e => setDelayDays(e.target.value)} />
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
                    <button type="button" onClick={savePayoutSchedule} disabled={payoutSaving}
                      style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: payoutSaving ? 'wait' : 'pointer', fontFamily: F, opacity: payoutSaving ? 0.6 : 1 }}>
                      {payoutSaving ? 'Saving…' : 'Save payout schedule'}
                    </button>
                    {payoutSavedOk && <span style={{ fontSize: 12, fontWeight: 600, color: '#16A34A' }}>✓ Saved to Stripe</span>}
                    {payoutErr && <span style={{ fontSize: 12, color: '#DC2626' }}>{payoutErr}</span>}
                  </div>
                  <p style={{ fontSize: 11, color: '#aaa', margin: '10px 0 0' }}>Delay is the funds-availability window (US minimum 2 days). Manual disables automatic payouts entirely.</p>
                </div>
              )}

              {/* Disco fullmap listing — Premium (Neon overrides). Map visibility
                  is controlled by the Marketplace toggle in the table row, so the
                  loaded `visible` value is round-tripped on save (not edited here). */}
              <div style={section}>
                <div style={sTitle}>Marketplace listing (Premium)</div>
                <p style={{ fontSize: 12, color: '#777', margin: '0 0 14px' }}>Controls the Disco fullmap. Saved to Disco (Neon).</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <label style={{ ...label, marginBottom: 0 }}>Premium</label>
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
              </div>

              {/* Cuisine — multi-select, up to 3, stored comma-separated in
                  disco_restaurant_cache.cuisine. */}
              <div style={section}>
                <div style={sTitle}>Cuisine</div>
                <p style={{ fontSize: 12, color: '#777', margin: '0 0 12px' }}>Pick up to 3 — shown as filter tags on the fullmap. ({cuisines.length}/{MAX_CUISINES})</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                  {cuisineOptions.map(c => {
                    const checked = cuisines.includes(c)
                    const disabled = !checked && cuisines.length >= MAX_CUISINES
                    return (
                      <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: disabled ? '#bbb' : DARK, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleCuisine(c)} style={{ accentColor: BLUE, cursor: disabled ? 'not-allowed' : 'pointer' }} />
                        {c}
                      </label>
                    )
                  })}
                </div>

                {/* Super admin: add a new cuisine type permanently. */}
                {addingCuisine ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                    <input
                      autoFocus value={newCuisine} onChange={e => setNewCuisine(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') addCuisineType(); if (e.key === 'Escape') { setAddingCuisine(false); setNewCuisine('') } }}
                      placeholder="New cuisine type"
                      style={{ flex: 1, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }}
                    />
                    <button onClick={addCuisineType} disabled={!newCuisine.trim() || addCuisineBusy}
                      style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: newCuisine.trim() && !addCuisineBusy ? 'pointer' : 'default', opacity: newCuisine.trim() && !addCuisineBusy ? 1 : 0.6, fontFamily: F }}>
                      {addCuisineBusy ? 'Adding…' : 'Add'}
                    </button>
                    <button onClick={() => { setAddingCuisine(false); setNewCuisine('') }}
                      style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, cursor: 'pointer', fontFamily: F }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setAddingCuisine(true)}
                    style={{ background: 'none', border: 'none', color: BLUE, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, padding: '12px 0 0', display: 'inline-block' }}>
                    + Add cuisine type
                  </button>
                )}
              </div>

              {/* Order URLs — read-only. 3P marketplace link sends sourceoforder
                  DISCO (lead-gen fee); 1P direct (/order/<slug>) sends FAMILYMEAL. */}
              {slug && (
                <div style={section}>
                  <div style={sTitle}>Order URLs</div>
                  <p style={{ fontSize: 12, color: '#777', margin: '0 0 14px' }}>Read-only. Share the 1P Direct link with the restaurant for commission-free orders.</p>
                  <CopyRow label="3P Marketplace (lead-gen fee)" url={`https://www.discocater.com/restaurants/${slug}`} />
                  <CopyRow label="1P Direct (no marketplace fee)" url={`https://www.discocater.com/order/${slug}`} />
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, padding: '14px 22px', borderTop: '1px solid #ececf2', background: '#fff', flexShrink: 0 }}>
          {savedOk && (
            <span style={{ marginRight: 'auto', fontSize: 13, fontWeight: 600, color: '#16A34A' }}>✓ Changes saved successfully.</span>
          )}
          <button onClick={onClose} disabled={saving} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }}>Cancel</button>
          <button onClick={submit} disabled={saving || loading || uploadingImage} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: (saving || loading || uploadingImage) ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Submit'}</button>
        </div>
      </div>
    </div>
  )
}
