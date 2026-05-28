'use client'
import { useState } from 'react'

// Mirrors FM's add-restaurant.component.ts form (admin/restaurant/update/
// add-restaurant). Field shape, enum values, and validation are taken
// from FM source directly — see docs/fm-super-admin-audit.md § D.5.

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'

// Parse a lead-gen percent, clamped to FM's 0-100 range; falls back to the
// FM default (15 / 3) when blank or invalid.
function pctOrDefault(raw: string, fallback: number): number {
  const n = parseFloat(raw)
  if (!isFinite(n)) return fallback
  return Math.min(100, Math.max(0, n))
}

// FAKE_RESTAURANT_CATEGORIES from FM source. Stored lowercase in the UI,
// uppercased before send (FM's component does `.toUpperCase()` on submit).
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'EVENT', label: 'Event' },
  { value: 'OFFICE', label: 'Office' },
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'POP_UP', label: 'Pop Up' },
  { value: 'MEAL_PREP', label: 'Meal Prep' },
  { value: 'PRIVATE_CHEF', label: 'Private Chef' },
  { value: 'WHOLESALE', label: 'Wholesale' },
  { value: 'SUBSCRIPTIONS', label: 'Subscriptions' },
  { value: 'EXCLUSIVES', label: 'Exclusives' },
]

// FAKE_RECEIVING_TYPES — PICKUP / DELIVERY / SHIPPING.
const FULFILLMENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'PICKUP', label: 'Pickup' },
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'SHIPPING', label: 'Shipping' },
]

const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Props {
  onClose: () => void
  onCreated: () => void
}

export default function AddRestaurantDialog({ onClose, onCreated }: Props) {
  const [businessName, setBusinessName] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [addressLine2, setAddressLine2] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zipcode, setZipcode] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')

  const [categories, setCategories] = useState<string[]>([])
  const [fulfillmentOptions, setFulfillmentOptions] = useState<string[]>([])

  // FM defaults these to 15% and 3% (add-restaurant.component.ts:231-232).
  const [leadGenOne, setLeadGenOne] = useState('15')
  const [leadGenTwo, setLeadGenTwo] = useState('3')

  const [menuFile, setMenuFile] = useState<File | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function validate(): string | null {
    if (!businessName.trim()) return 'Restaurant name is required'
    if (!addressLine1.trim()) return 'Street address is required'
    if (!city.trim()) return 'City is required'
    if (!state.trim()) return 'State is required'
    if (!ZIP_PATTERN.test(zipcode.trim())) return 'Zipcode must be 5 digits (or 5+4)'
    if (!phoneNumber.trim()) return 'Phone number is required'
    if (!firstName.trim()) return 'Admin first name is required'
    if (!lastName.trim()) return 'Admin last name is required'
    if (!EMAIL_PATTERN.test(email.trim())) return 'Valid admin email is required'
    if (categories.length === 0) return 'Pick at least one category'
    if (fulfillmentOptions.length === 0) return 'Pick at least one fulfillment option'
    return null
  }

  function toggleCategory(v: string) {
    setCategories(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])
  }

  function toggleFulfillment(v: string) {
    setFulfillmentOptions(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])
  }

  async function submit() {
    const v = validate()
    if (v) { setErr(v); return }
    setSubmitting(true); setErr(null)
    try {
      // Same shape as FM's add-restaurant.component.ts:97-119. address
      // and admin are nested, categories/fulfillmentOptions are top-
      // level, lead-gen fields snake_case → camelCase on send.
      const restaurant = {
        businessName: businessName.trim(),
        address: {
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim(),
          state: state.trim().toUpperCase(),
          zipcode: zipcode.trim(),
          phoneNumber: phoneNumber.trim(),
        },
        admin: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
        },
        categories,
        fulfillmentOptions,
        // FM stores these as numbers (0-100), defaulting to 15 / 3.
        leadGenOne: pctOrDefault(leadGenOne, 15),
        leadGenTwo: pctOrDefault(leadGenTwo, 3),
      }
      const fd = new FormData()
      fd.append('restaurant', new Blob([JSON.stringify(restaurant)], { type: 'application/json' }))
      if (menuFile) fd.append('file', menuFile)

      const res = await fetch('/api/admin/restaurants', { method: 'POST', body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.error || `Save failed (HTTP ${res.status})`)
      }
      onCreated()
    } catch (e) {
      setErr((e as Error).message || 'Unable to create restaurant')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div onClick={() => !submitting && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: F }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 14, maxWidth: 720, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 28px', borderBottom: '1px solid #ececf2', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: DARK }}>Add Restaurant</h2>
          <button onClick={onClose} disabled={submitting}
            style={{ background: '#f4f4f8', border: 'none', width: 30, height: 30, borderRadius: '50%', fontSize: 18, color: '#555', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
          {err && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#DC2626' }}>
              {err}
            </div>
          )}

          <SectionTitle>Restaurant</SectionTitle>
          <Field label="Business name *"><input style={input} value={businessName} onChange={e => setBusinessName(e.target.value)} /></Field>
          <Field label="Street address *"><input style={input} value={addressLine1} onChange={e => setAddressLine1(e.target.value)} placeholder="123 Main St" /></Field>
          <Field label="Suite / unit"><input style={input} value={addressLine2} onChange={e => setAddressLine2(e.target.value)} placeholder="Optional" /></Field>
          <Grid cols={3}>
            <Field label="City *"><input style={input} value={city} onChange={e => setCity(e.target.value)} /></Field>
            <Field label="State *"><input style={input} value={state} onChange={e => setState(e.target.value.toUpperCase())} maxLength={2} placeholder="NY" /></Field>
            <Field label="Zipcode *"><input style={input} value={zipcode} onChange={e => setZipcode(e.target.value)} maxLength={10} placeholder="10001" /></Field>
          </Grid>
          <Field label="Phone *"><input style={input} value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="000-000-0000" /></Field>

          <SectionTitle>Admin contact</SectionTitle>
          <Grid cols={2}>
            <Field label="First name *"><input style={input} value={firstName} onChange={e => setFirstName(e.target.value)} /></Field>
            <Field label="Last name *"><input style={input} value={lastName} onChange={e => setLastName(e.target.value)} /></Field>
          </Grid>
          <Field label="Email *"><input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@restaurant.com" /></Field>

          <SectionTitle>Categories *</SectionTitle>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {CATEGORY_OPTIONS.map(c => (
              <Check key={c.value} checked={categories.includes(c.value)} onChange={() => toggleCategory(c.value)} label={c.label} />
            ))}
          </div>

          <SectionTitle>Fulfillment *</SectionTitle>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {FULFILLMENT_OPTIONS.map(o => (
              <Check key={o.value} checked={fulfillmentOptions.includes(o.value)} onChange={() => toggleFulfillment(o.value)} label={o.label} />
            ))}
          </div>

          <SectionTitle>Lead generation</SectionTitle>
          <p style={{ fontSize: 12, color: '#777', margin: '0 0 8px' }}>
            Percentage fees withheld from the restaurant&apos;s payout. FamilyMeal defaults: 15% and 3%.
          </p>
          <Grid cols={2}>
            <Field label="Lead gen 1 (%)">
              <input style={input} type="number" min={0} max={100} step="0.1" value={leadGenOne}
                onChange={e => setLeadGenOne(e.target.value)} placeholder="15" />
            </Field>
            <Field label="Lead gen 2 (%)">
              <input style={input} type="number" min={0} max={100} step="0.1" value={leadGenTwo}
                onChange={e => setLeadGenTwo(e.target.value)} placeholder="3" />
            </Field>
          </Grid>

          <SectionTitle>Initial menu (optional)</SectionTitle>
          <p style={{ fontSize: 12, color: '#777', margin: '0 0 8px' }}>Upload a CSV file to seed the restaurant's first menu. Leave empty to start from scratch.</p>
          <input type="file" accept=".csv,text/csv"
            onChange={e => setMenuFile(e.target.files?.[0] || null)}
            style={{ fontSize: 13, fontFamily: F }} />
          {menuFile && <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>Selected: {menuFile.name}</div>}
        </div>

        <div style={{ padding: '14px 28px', borderTop: '1px solid #ececf2', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} disabled={submitting}
            style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }}>Cancel</button>
          <button onClick={submit} disabled={submitting}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1, fontFamily: F }}>
            {submitting ? 'Creating…' : 'Create restaurant'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '6px 0 10px', borderBottom: '1px solid #f0f0f0', paddingBottom: 6 }}>{children}</div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )
}

function Grid({ cols, children }: { cols: number; children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 12 }}>{children}</div>
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px',
      borderRadius: 20, border: '1.5px solid ' + (checked ? INDIGO : '#e0e0e0'),
      background: checked ? 'rgba(107,110,249,0.08)' : '#fff', cursor: 'pointer',
      fontFamily: F, fontSize: 12, fontWeight: 600, color: checked ? INDIGO : '#555',
    }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ accentColor: INDIGO }} />
      {label}
    </label>
  )
}

const input: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0',
  borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff',
}
