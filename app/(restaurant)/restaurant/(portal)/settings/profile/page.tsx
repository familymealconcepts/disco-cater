'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRestaurant } from '../../context/RestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'

const inputSt: React.CSSProperties = {
  width: '100%', padding: '10px 13px', border: '1.5px solid #e0e0e0',
  borderRadius: 9, fontSize: 13, fontFamily: F, color: DARK, outline: 'none',
}
const labelSt: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6,
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '22px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, marginTop: 0, marginBottom: 18 }}>{title}</h2>
      {children}
    </div>
  )
}

export default function RestaurantProfilePage() {
  const { refreshProfile } = useRestaurant()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [description, setDescription] = useState('')
  const [cuisineType, setCuisineType] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [coverUrl, setCoverUrl] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/profile', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        setName(d.businessName || d.name || `${d.firstName || ''} ${d.lastName || ''}`.trim())
        setPhone(d.phoneNumber || d.phone || '')
        setEmail(d.email || '')
        setWebsite(d.website || d.websiteUrl || '')
        setDescription(d.description || d.bio || '')
        setCuisineType(d.cuisineType || d.cuisine || '')
        setImageUrl(d.image || d.logoUrl || '')
        setCoverUrl(d.coverImage || d.heroImage || '')
      } else {
        const err = await res.json()
        setError(err.error || `FM API returned ${res.status}`)
      }
    } catch {
      setError('Unable to load restaurant profile.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function uploadToSanity(file: File): Promise<string | null> {
    try {
      const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
      const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET || 'production'
      const token = process.env.NEXT_PUBLIC_SANITY_WRITE_TOKEN || ''
      const res = await fetch(
        `https://${projectId}.api.sanity.io/v2021-03-25/assets/images/${dataset}`,
        {
          method: 'POST',
          headers: { 'Content-Type': file.type, Authorization: `Bearer ${token}` },
          body: file,
        }
      )
      if (!res.ok) return null
      const data = await res.json()
      return data.document?.url || null
    } catch {
      return null
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>, type: 'profile' | 'cover') {
    const file = e.target.files?.[0]
    if (!file) return
    if (type === 'profile') setUploadingImage(true)
    else setUploadingCover(true)
    try {
      const url = await uploadToSanity(file)
      if (url) {
        if (type === 'profile') setImageUrl(url)
        else setCoverUrl(url)
        showToast('Image uploaded', true)
      } else {
        showToast('Image upload failed — check Sanity token', false)
      }
    } finally {
      if (type === 'profile') setUploadingImage(false)
      else setUploadingCover(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/restaurant/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name, businessName: name, phoneNumber: phone, email,
          website, description, cuisineType, image: imageUrl, coverImage: coverUrl,
        }),
      })
      if (res.ok) {
        setLastSaved(new Date())
        showToast('Profile saved successfully', true)
        refreshProfile()
      } else {
        const d = await res.json()
        showToast(d.error || 'Failed to save profile', false)
      }
    } catch {
      showToast('Failed to save profile', false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .rp-input:focus { border-color: ${INDIGO} !important; box-shadow: 0 0 0 3px rgba(107,110,249,0.1) !important; }
        .rp-upload-btn { padding: 9px 16px; border: 1.5px dashed #d0d0d0; border-radius: 9px; background: #fafafa; cursor: pointer; font-size: 13px; font-family: ${F}; color: #666; display: inline-flex; align-items: center; gap: 8px; transition: border-color 0.12s; }
        .rp-upload-btn:hover { border-color: ${INDIGO}; color: ${INDIGO}; }
      `}</style>

      <div style={{ fontFamily: F, maxWidth: 680 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: 0 }}>Restaurant Profile</h1>
          {lastSaved && <div style={{ fontSize: 12, color: '#aaa' }}>Last saved {lastSaved.toLocaleTimeString()}</div>}
        </div>

        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#DC2626' }}>
            <strong>API Error:</strong> {error}
            <div style={{ fontSize: 11, marginTop: 4, color: '#9CA3AF' }}>
              Profile data could not be loaded from FM API.
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#aaa', fontSize: 14 }}>Loading profile…</div>
        ) : (
          <>
            {/* Basic info */}
            <SectionCard title="Basic Information">
              <div style={{ marginBottom: 14 }}>
                <label style={labelSt}>Restaurant name</label>
                <input className="rp-input" value={name} onChange={e => setName(e.target.value)} style={inputSt} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={labelSt}>Phone number</label>
                  <input className="rp-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} style={inputSt} />
                </div>
                <div>
                  <label style={labelSt}>Email (for notifications)</label>
                  <input className="rp-input" type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputSt} />
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelSt}>Website URL</label>
                <input className="rp-input" type="url" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://yourrestaurant.com" style={inputSt} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelSt}>Cuisine type</label>
                <input className="rp-input" value={cuisineType} onChange={e => setCuisineType(e.target.value)} placeholder="e.g. Italian, BBQ, American" style={inputSt} />
              </div>
              <div>
                <label style={labelSt}>Description</label>
                <textarea
                  className="rp-input"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={4}
                  placeholder="Tell customers about your restaurant, specialties, and catering offerings…"
                  style={{ ...inputSt, resize: 'vertical' }}
                />
              </div>
            </SectionCard>

            {/* Images */}
            <SectionCard title="Images">
              {/* Profile photo */}
              <div style={{ marginBottom: 22 }}>
                <label style={labelSt}>Profile photo (logo)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ width: 72, height: 72, borderRadius: 12, background: '#f4f4f8', overflow: 'hidden', flexShrink: 0, border: '1px solid #e0e0e0' }}>
                    {imageUrl ? <img src={imageUrl} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>🍽️</div>}
                  </div>
                  <div>
                    <label className="rp-upload-btn">
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleImageUpload(e, 'profile')} />
                      {uploadingImage ? 'Uploading…' : '📷 Upload photo'}
                    </label>
                    <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>Uploaded to Sanity CDN</div>
                  </div>
                </div>
              </div>

              {/* Cover image */}
              <div>
                <label style={labelSt}>Cover / hero image</label>
                <div style={{ marginBottom: 10, borderRadius: 10, overflow: 'hidden', height: 120, background: '#f4f4f8', border: '1px solid #e0e0e0' }}>
                  {coverUrl ? <img src={coverUrl} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 13 }}>No cover image</div>}
                </div>
                <label className="rp-upload-btn">
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleImageUpload(e, 'cover')} />
                  {uploadingCover ? 'Uploading…' : '📷 Upload cover image'}
                </label>
              </div>
            </SectionCard>

            {/* Save */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 32 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ padding: '12px 28px', background: saving ? '#ccc' : INDIGO, color: '#fff', border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}
              >
                {saving ? 'Saving…' : 'Save Profile'}
              </button>
            </div>
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.ok ? '#1D9E75' : '#E24B4A', color: '#fff', padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', fontFamily: F }}>
          {toast.msg}
        </div>
      )}
    </>
  )
}
