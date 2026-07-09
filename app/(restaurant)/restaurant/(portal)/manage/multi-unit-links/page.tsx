'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import ReactCrop, { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import { confirmDialog } from '../../../../../components/ui/feedback'

// Link images render in a 16:9 header on /locations/[slug], so crop to match.
const CROP_ASPECT = 16 / 9

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const INDIGO = '#5B6FE8'
const PAGE_BG = '#F7F8FC'
const FM_IMG_BASE = 'https://api.familymeal.com/public-api/images'

// Where the shareable links resolve — the Disco Cater multi-unit
// /locations/{slug} page.
const DISCO_BASE = 'https://www.discocater.com/locations/'

// FM's link object — fields observed on /api/system-admin/restaurants/links.
// `urlFrom: 'Dashboard'` is the "this is the restaurant's own dashboard
// link" indicator FM uses to hide Delete on the auto-managed row.
interface MultiLink {
  reference: string
  url: string                            // slug, no domain
  header?: string                        // display title
  numberOfLocations?: number
  restaurantReferences?: string[]        // associated location refs
  locationImage?: string                 // image reference (FM image CDN)
  image?: { reference?: string }
  urlFrom?: string                       // 'Dashboard' | 'Links' | undefined
  multiUnitLinksReference?: string | null
}

interface LocationOption {
  reference: string
  businessName: string
}

// FM's dashboard group payload (GET /api/system-admin/groups) — the restaurant's
// own primary group url, used to scope the listing + pin the Dashboard row.
interface GroupInfo {
  name?: string
  url?: string
  header?: string
  numberOfLocations?: number
  restaurantReferences?: string[]
  image?: { reference?: string }
  locationImage?: string
  multiUnitLinksReference?: string | null
}

function imageUrl(l: Partial<MultiLink>): string | null {
  const ref = l.image?.reference || l.locationImage
  if (!ref) return null
  if (ref.startsWith('http')) return ref
  return `${FM_IMG_BASE}/${ref}/download?size=80`
}

// Pull FM's human-readable error (err.description / err.error.description) out
// of the raw error body the proxy forwards, for inline display.
function parseDescription(raw?: string): string | null {
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    return j?.description || j?.error?.description || j?.message || null
  } catch {
    return raw.length < 200 ? raw : null
  }
}

export default function MultiUnitLinksPage() {
  const [links, setLinks] = useState<MultiLink[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<MultiLink> | null>(null)
  const [saving, setSaving] = useState(false)
  const [locations, setLocations] = useState<LocationOption[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [dashboardGroup, setDashboardGroup] = useState<GroupInfo | null>(null)
  // slug → Vercel Blob image URL (from the Neon mirror) for table thumbnails.
  const [imageMap, setImageMap] = useState<Record<string, string>>({})
  // slug → manual header-gradient override (Neon mirror), for pre-filling the editor.
  const [gradientMap, setGradientMap] = useState<Record<string, string>>({})
  // Dialog: manual header gradient override (two color stops + on/off toggle).
  const [gradEnabled, setGradEnabled] = useState(false)
  const [gradStart, setGradStart] = useState('#6B6EF9')
  const [gradEnd, setGradEnd] = useState('#C044C8')
  // slug → number of locations FM serves publicly (what /locations/[slug] shows).
  const [liveCounts, setLiveCounts] = useState<Record<string, number>>({})

  // Dialog-scoped state
  const [urlError, setUrlError] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [imageUpdated, setImageUpdated] = useState(false)
  const [imageError, setImageError] = useState('')
  // Inline 16:9 cropper state — set when a file is picked, cleared on crop/cancel.
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState<Crop>()
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>()
  const [cropFileName, setCropFileName] = useState('image')
  const cropImgRef = useRef<HTMLImageElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    // FM (loadLocationsInfo -> getLinksData): fetch the dashboard group FIRST so
    // we can pass its url as `dashboardUrl` and pin/synthesize the Dashboard row.
    let group: GroupInfo | null = null
    try {
      const gr = await fetch('/api/restaurant/multi-unit-links/group')
      if (gr.ok) { group = await gr.json(); setDashboardGroup(group) }
    } catch { /* best-effort — listing still works without it */ }

    const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
    if (group?.url) params.set('dashboardUrl', group.url)
    try {
      const res = await fetch(`/api/restaurant/multi-unit-links?${params}`)
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        setError(d?.error || `Failed to load links (HTTP ${res.status})`)
        setLinks([]); setTotal(0)
      } else {
        const data = await res.json()
        // FM's /links/listing returns either a paginated envelope or a
        // plain array depending on the deployment — handle both.
        let items: MultiLink[]
        let tot: number
        if (Array.isArray(data)) {
          items = data; tot = data.length
        } else {
          items = data.content || data.data || []
          tot = data.totalElements ?? data.total ?? (items.length || 0)
        }
        const { rows, total: pinnedTotal } = pinDashboardRow(items, group, tot)
        setLinks(rows); setTotal(pinnedTotal)

        // Pull the source-of-truth blob image URLs (Neon mirror) for these
        // links so the table thumbnails don't rely on stale FM image refs.
        const slugs = rows.map(r => r.url).filter(Boolean)
        if (slugs.length) {
          try {
            const imgRes = await fetch(`/api/restaurant/multi-unit-links/images?slugs=${encodeURIComponent(slugs.join(','))}`)
            if (imgRes.ok) {
              const imgData = await imgRes.json().catch(() => null)
              setImageMap(imgData?.images || {})
              setGradientMap(imgData?.gradients || {})
            }
          } catch { /* thumbnails fall back to the FM ref */ }

          // Live count: how many locations FM actually serves for each slug
          // (what /locations/[slug] renders). Fired in parallel, best-effort.
          Promise.all(slugs.map(async slug => {
            try {
              const r = await fetch(`/api/restaurant/multi-unit-links/live-count?slug=${encodeURIComponent(slug)}`)
              if (!r.ok) return [slug, undefined] as const
              const d = await r.json().catch(() => null)
              return [slug, typeof d?.liveCount === 'number' ? d.liveCount : undefined] as const
            } catch { return [slug, undefined] as const }
          })).then(entries => {
            const map: Record<string, number> = {}
            for (const [slug, count] of entries) if (typeof count === 'number') map[slug] = count
            setLiveCounts(map)
          }).catch(() => {})
        }
      }
    } catch {
      setError('Unable to reach server')
      setLinks([]); setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize])

  // Replicate FM's getLinksData() Dashboard handling: find the dashboard row
  // (by urlFrom or matching group url), tag it 'Dashboard', and pin it to the
  // top. If it isn't in the listing, synthesize one from the group data and
  // bump the count by 1 (mirrors FM's collectionSize + 1).
  function pinDashboardRow(items: MultiLink[], group: GroupInfo | null, tot: number) {
    const rows = [...items]
    if (!group?.url) return { rows, total: tot }
    const idx = rows.findIndex(r => r.urlFrom === 'Dashboard' || r.url === group.url)
    if (idx !== -1) {
      const [row] = rows.splice(idx, 1)
      rows.unshift({ ...row, urlFrom: 'Dashboard' })
      return { rows, total: tot }
    }
    rows.unshift({
      reference: '',
      url: group.url,
      header: group.header || group.name || '',
      urlFrom: 'Dashboard',
      restaurantReferences: group.restaurantReferences || [],
      numberOfLocations: group.numberOfLocations ?? (group.restaurantReferences?.length || 0),
      image: group.image,
      locationImage: group.locationImage,
      multiUnitLinksReference: group.multiUnitLinksReference ?? null,
    })
    return { rows, total: tot + 1 }
  }

  useEffect(() => { load() }, [load])

  // Load all locations once for the multi-select picker in the dialog.
  useEffect(() => {
    fetch('/api/restaurant/locations?size=1000')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.content) {
          setLocations(d.content.map((l: { reference: string; businessName: string }) => ({
            reference: l.reference, businessName: l.businessName,
          })))
        }
      })
      .catch(() => {})
  }, [])

  function openDialog(link: Partial<MultiLink>) {
    setUrlError(''); setImageError(''); setImageFile(null); setImageUpdated(false)
    // Show the existing image (if any) when editing; nothing for a brand-new link.
    setImagePreview((link.reference || link.urlFrom === 'Dashboard') ? imageUrl(link) : null)
    // Pre-fill the manual gradient override from the mirror (parse its two hex stops).
    const stops = (gradientMap[link.url || ''] || '').match(/#[0-9a-fA-F]{3,8}/g)
    if (stops && stops.length >= 2) { setGradEnabled(true); setGradStart(stops[0]); setGradEnd(stops[1]) }
    else { setGradEnabled(false); setGradStart('#6B6EF9'); setGradEnd('#C044C8') }
    setEditing(link)
  }

  function closeDialog() {
    if (imageFile && imagePreview) URL.revokeObjectURL(imagePreview)
    setEditing(null); setImageFile(null); setImagePreview(null); setUrlError(''); setImageError('')
    setCropSrc(null); setCrop(undefined); setCompletedCrop(undefined)
  }

  // Pick a file → load it into the inline cropper (no upload yet). The cropped
  // result becomes imageFile on "Crop & Save".
  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!/image\/(jpeg|png)/.test(f.type)) { setImageError('Please choose a .jpg or .png'); return }
    if (f.size > 5 * 1024 * 1024) { setImageError('Image must be 5MB or less'); return }
    setImageError('')
    setCropFileName((f.name || 'image').replace(/\.[^.]+$/, ''))
    setCrop(undefined); setCompletedCrop(undefined)
    const reader = new FileReader()
    reader.onload = () => setCropSrc(String(reader.result || ''))
    reader.readAsDataURL(f)
  }

  // Seed a centered 16:9 crop once the image is laid out in the cropper.
  function onCropImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget
    setCrop(centerCrop(makeAspectCrop({ unit: '%', width: 90 }, CROP_ASPECT, width, height), width, height))
  }

  // Draw the selected crop region to a canvas → JPEG blob → File, and adopt it as
  // the image to upload.
  async function cropAndSave() {
    const image = cropImgRef.current
    const c = completedCrop
    if (!image || !c || !c.width || !c.height) { setImageError('Please select a crop area.'); return }
    const scaleX = image.naturalWidth / image.width
    const scaleY = image.naturalHeight / image.height
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(c.width * scaleX))
    canvas.height = Math.max(1, Math.floor(c.height * scaleY))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(
      image,
      c.x * scaleX, c.y * scaleY, c.width * scaleX, c.height * scaleY,
      0, 0, canvas.width, canvas.height,
    )
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.9))
    if (!blob) { setImageError('Could not crop the image. Please try again.'); return }
    const file = new File([blob], `${cropFileName}.jpg`, { type: 'image/jpeg' })
    if (imageFile && imagePreview) URL.revokeObjectURL(imagePreview)
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
    setImageUpdated(true)
    setCropSrc(null); setCrop(undefined); setCompletedCrop(undefined)
  }

  function cancelCrop() {
    setCropSrc(null); setCrop(undefined); setCompletedCrop(undefined); setImageError('')
  }

  function removeImage() {
    if (imageFile && imagePreview) URL.revokeObjectURL(imagePreview)
    setImageFile(null)
    setImagePreview(null)
    setCropSrc(null); setCrop(undefined); setCompletedCrop(undefined)
    setImageUpdated(true) // signal the backend to clear the existing image
  }

  // Upload the selected image to Vercel Blob and return its public URL (or null).
  async function uploadLinkImage(file: File): Promise<string | null> {
    try {
      const fd = new FormData()
      fd.append('image', file)
      const res = await fetch('/api/restaurant/multi-unit-links/upload-image', { method: 'POST', body: fd })
      const d = await res.json().catch(() => null)
      console.log('[patchLinkImage] blob upload result:', res.status, d?.url || d?.error || d)
      if (!res.ok) { console.error('[multi-unit-links] blob upload failed:', res.status, d?.error); return null }
      return d?.url || null
    } catch (e) {
      console.error('[multi-unit-links] blob upload request failed:', e)
      return null
    }
  }

  // Store the link's image_url (a Vercel Blob URL) in the Neon mirror so the
  // public /locations/[slug] header can show it. Pass '' to clear. Best effort.
  async function patchLinkImage(slug: string, reference: string, imageUrl: string) {
    if (!slug) return
    console.log('[patchLinkImage] slug:', slug, 'imageUrl to store:', imageUrl)
    try {
      const ref = reference || 'by-slug' // [ref] is routing-only; row is keyed by slug
      const res = await fetch(`/api/restaurant/multi-unit-links/${encodeURIComponent(ref)}/image`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, imageUrl }),
      })
      console.log('[patchLinkImage] PATCH response status:', res.status)
      if (!res.ok) console.error('[multi-unit-links] image patch failed:', res.status, await res.text().catch(() => ''))
    } catch (e) {
      console.error('[multi-unit-links] image patch failed:', e)
    }
  }

  // Store (or clear with null) the link's manual header-gradient override in the
  // Neon mirror so the public /locations/[slug] header can use it. Best effort.
  async function patchLinkGradient(slug: string, reference: string, gradient: string | null) {
    if (!slug) return
    try {
      const ref = reference || 'by-slug' // [ref] is routing-only; row is keyed by slug
      await fetch(`/api/restaurant/multi-unit-links/${encodeURIComponent(ref)}/gradient`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, gradient }),
      })
    } catch (e) {
      console.error('[multi-unit-links] gradient patch failed:', e)
    }
  }

  async function saveLink() {
    if (!editing || !editing.url || !editing.header) return
    if (!(editing.restaurantReferences || []).length) return // FM requires ≥1 location
    setSaving(true)
    setUrlError('')
    // Capture before closeDialog() nulls `editing`.
    const savedSlug = editing.url || ''
    const savedRef = editing.reference || ''
    const imageWasChanged = imageUpdated
    const fileToUpload = imageFile
    const gradientToSave = gradEnabled ? `linear-gradient(120deg, ${gradStart} 0%, ${gradEnd} 100%)` : null

    // Upload the image to Vercel Blob BEFORE the FM call (it's the source of
    // truth for display). FM still gets a copy below for its own compatibility.
    let blobUrl: string | null = null
    if (fileToUpload) blobUrl = await uploadLinkImage(fileToUpload)
    const isDashboard = editing.urlFrom === 'Dashboard'
    const isEdit = !!editing.reference

    // Mirror FM's submitData() request blob. `userReference` is injected
    // server-side from the JWT (the httpOnly cookie can't be read here). FM only
    // includes `imageUpdated` for edits / the Dashboard row, never brand-new.
    const reqBody: Record<string, unknown> = {
      header: editing.header,
      url: editing.url,
      restaurantReferences: editing.restaurantReferences || [],
      numberOfLocations: (editing.restaurantReferences || []).length,
      urlFrom: isDashboard ? 'Dashboard' : 'Links',
      multiUnitLinksReference: editing.multiUnitLinksReference ?? editing.reference ?? null,
    }
    if (isDashboard || isEdit) reqBody.imageUpdated = imageUpdated

    // multipart: JSON `request` part + optional `image` file part (matches FM).
    const fd = new FormData()
    fd.append('request', new Blob([JSON.stringify(reqBody)], { type: 'application/json' }))
    if (imageFile) fd.append('image', imageFile)

    // Dashboard row edits go to the dedicated groups endpoint, NOT the links PUT.
    const url = isDashboard
      ? `/api/restaurant/multi-unit-links/group?url=${encodeURIComponent(editing.url)}`
      : isEdit
        ? `/api/restaurant/multi-unit-links/${editing.reference}`
        : '/api/restaurant/multi-unit-links'
    const method = isDashboard ? 'PUT' : isEdit ? 'PUT' : 'POST'

    try {
      // No Content-Type header — the browser sets the multipart boundary.
      const res = await fetch(url, { method, body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        const desc = parseDescription(d?.raw) || d?.error
        setUrlError(desc || `Save failed (HTTP ${res.status})`)
      } else {
        closeDialog()
        // Mirror the image into Neon (best effort): the new blob URL if one was
        // uploaded, or '' to clear it if the image was removed.
        if (blobUrl) await patchLinkImage(savedSlug, savedRef, blobUrl)
        else if (imageWasChanged && !fileToUpload) await patchLinkImage(savedSlug, savedRef, '')
        await patchLinkGradient(savedSlug, savedRef, gradientToSave)
        load()
      }
    } finally { setSaving(false) }
  }

  async function deleteLink(l: MultiLink) {
    if (l.urlFrom === 'Dashboard') return
    if (!(await confirmDialog(`Delete the link "${l.header || l.url}"? This cannot be undone.`, { title: 'Delete link', confirmText: 'Delete', danger: true }))) return
    await fetch(`/api/restaurant/multi-unit-links/${l.reference}`, { method: 'DELETE' })
    load()
  }

  function toggleLocation(ref: string) {
    if (!editing) return
    const cur = editing.restaurantReferences || []
    const next = cur.includes(ref) ? cur.filter(r => r !== ref) : [...cur, ref]
    setEditing({ ...editing, restaurantReferences: next, numberOfLocations: next.length })
  }

  function copy(text: string, id: string) {
    try {
      navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(c => (c === id ? null : c)), 1500)
    } catch {}
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: PAGE_BG, borderBottom: '1px solid #f0f0f0', letterSpacing: '0.04em' }
  const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }

  const noLocations = !(editing?.restaurantReferences || []).length

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Locations</h1>
          <p style={{ fontSize: 12, color: '#777', margin: '4px 0 0', lineHeight: 1.5, maxWidth: 600 }}>
            Shareable URLs that route customers to one or more of your locations.
            Share the Disco Cater URL with your customers.
          </p>
        </div>
        <button onClick={() => openDialog({ url: '', header: '', restaurantReferences: [] })}
          style={{ padding: '10px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
          + Add Link
        </button>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, margin: '14px 0', fontSize: 13 }}>{error}</div>}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden', marginTop: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...colHead, width: 80 }}>Image</th>
            <th style={colHead}>URL</th>
            <th style={colHead}>Title</th>
            <th style={{ ...colHead, width: 110, textAlign: 'right' }}># Locations</th>
            <th style={{ ...colHead, width: 60, textAlign: 'center' }}>Open</th>
            <th style={{ ...colHead, width: 140, textAlign: 'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999', padding: '32px 14px' }}>Loading…</td></tr>}
            {!loading && !links.length && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999', padding: '32px 14px' }}>No links yet.</td></tr>}
            {!loading && links.map(l => {
              // Prefer the Neon blob URL (source of truth); fall back to the FM ref.
              const img = imageMap[l.url] || imageUrl(l)
              const discoUrl = `${DISCO_BASE}${l.url}`
              const protectedRow = l.urlFrom === 'Dashboard'
              return (
                <tr key={l.reference || `dashboard-${l.url}`}>
                  <td style={cell}>
                    {img ? (
                      <img src={img} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', border: '1px solid #eee' }} />
                    ) : (
                      <div style={{ width: 44, height: 44, background: '#f0f0f4', borderRadius: 8, border: '1px solid #eee' }} />
                    )}
                  </td>
                  <td style={cell}>
                    {/* Primary: Disco Cater */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <a href={discoUrl} target="_blank" rel="noreferrer"
                        style={{ color: INDIGO, textDecoration: 'none', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}
                        title={discoUrl}>
                        {discoUrl}
                      </a>
                      <button onClick={() => copy(discoUrl, `disco-${l.reference || l.url}`)} title="Copy"
                        style={iconBtn}>
                        {copied === `disco-${l.reference || l.url}` ? '✓' : '⧉'}
                      </button>
                    </div>
                  </td>
                  <td style={{ ...cell, color: '#444' }}>
                    {l.header || '—'}
                    {protectedRow && (
                      <span style={{ marginLeft: 6, fontSize: 10, padding: '2px 6px', borderRadius: 10, background: '#EEF0FD', color: INDIGO, fontWeight: 700 }}>Dashboard</span>
                    )}
                  </td>
                  {/* Configured (restaurantReferences) vs live (what FM serves
                      publicly for the slug). Green = match, amber = fewer live,
                      red = none live. */}
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {(() => {
                      const configured = l.restaurantReferences ? l.restaurantReferences.length : (l.numberOfLocations ?? 0)
                      const live = liveCounts[l.url]
                      if (live === undefined) return <span style={{ color: '#777' }}>{configured}</span>
                      if (live === configured) return <span style={{ color: '#16A34A' }}>{configured}</span>
                      const liveColor = live === 0 ? '#E53935' : '#D98A00'
                      return (
                        <span>
                          {configured} configured <span style={{ color: '#bbb' }}>·</span> <span style={{ color: liveColor }}>{live} live</span>
                        </span>
                      )
                    })()}
                  </td>
                  <td style={{ ...cell, textAlign: 'center' }}>
                    <a href={discoUrl} target="_blank" rel="noreferrer" title="Open" style={{ color: INDIGO, textDecoration: 'none', fontSize: 16 }}>↗</a>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => openDialog(l)} style={btnLink}>Edit</button>
                    {!protectedRow && (
                      <button onClick={() => deleteLink(l)} style={{ ...btnLink, color: '#E76F51' }}>Delete</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }}
            style={{ border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
      </div>

      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => !saving && closeDialog()}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 560, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: F }}>
            <h3 style={{ margin: '0 0 18px', fontSize: 17, fontWeight: 700, color: DARK }}>
              {editing.urlFrom === 'Dashboard' ? 'Edit Dashboard Link' : editing.reference ? 'Edit Link' : 'New Link'}
            </h3>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 4 }}>
              <div>
                <label style={lbl}>Title</label>
                <input style={input} value={editing.header || ''} placeholder="Group name shown on the locations page"
                  onChange={e => setEditing({ ...editing, header: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>URL slug</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>{DISCO_BASE}</span>
                  <input style={{ ...input, borderColor: urlError ? '#E76F51' : '#e0e0e0' }} value={editing.url || ''} placeholder="my-group"
                    onChange={e => { setUrlError(''); setEditing({ ...editing, url: e.target.value.toLowerCase().replace(/^\/+/, '') }) }} />
                </div>
                {urlError && <div style={{ color: '#E76F51', fontSize: 12, marginTop: 6 }}>{urlError}</div>}
              </div>
              <div>
                <label style={lbl}>Locations ({(editing.restaurantReferences || []).length})</label>
                <div style={{ border: '1.5px solid ' + (noLocations ? '#f0c9be' : '#e0e0e0'), borderRadius: 8, maxHeight: 220, overflowY: 'auto', padding: 4 }}>
                  {locations.length === 0 && (
                    <div style={{ padding: 14, fontSize: 12, color: '#999' }}>No locations loaded.</div>
                  )}
                  {locations.map(loc => {
                    const checked = (editing.restaurantReferences || []).includes(loc.reference)
                    return (
                      <label key={loc.reference}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: DARK, background: checked ? '#EEF0FD' : 'transparent' }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleLocation(loc.reference)} style={{ accentColor: INDIGO }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc.businessName}</span>
                      </label>
                    )
                  })}
                </div>
                {noLocations && <div style={{ color: '#E76F51', fontSize: 12, marginTop: 6 }}>Choose at least one location.</div>}
              </div>
              <div>
                <label style={lbl}>Link Image</label>
                <p style={{ fontSize: 11, color: '#999', margin: '0 0 8px' }}>Upload a .jpg or .png up to 5MB. You&apos;ll crop it to a 16:9 banner.</p>
                {cropSrc ? (
                  // Inline 16:9 crop UI — clean white card matching the dialog.
                  <div style={{ background: '#fff', padding: 16, borderRadius: 8, border: '1px solid #e6e6ee' }}>
                    <ReactCrop
                      crop={crop}
                      onChange={(_px, percent) => setCrop(percent)}
                      onComplete={c => setCompletedCrop(c)}
                      aspect={CROP_ASPECT}
                      keepSelection
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img ref={cropImgRef} src={cropSrc} alt="Crop preview" onLoad={onCropImageLoad} style={{ maxHeight: 320, maxWidth: '100%', display: 'block' }} />
                    </ReactCrop>
                    <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                      <button type="button" onClick={cropAndSave}
                        style={{ padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                        Crop &amp; Save
                      </button>
                      <button type="button" onClick={cancelCrop}
                        style={{ padding: '9px 18px', background: '#fff', color: '#555', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : imagePreview ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ width: 120, height: 67.5, borderRadius: 8, border: '1px solid #eee', backgroundImage: `url(${imagePreview})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                    <button type="button" onClick={removeImage} style={{ ...btnLink, color: '#E76F51', marginLeft: 0 }}>Remove</button>
                  </div>
                ) : (
                  <label style={{ display: 'inline-block', cursor: 'pointer', padding: '9px 16px', border: '1.5px dashed #cfcfe0', borderRadius: 8, fontSize: 13, color: INDIGO, fontWeight: 600 }}>
                    Upload image
                    <input type="file" accept="image/jpeg,image/png" onChange={onPickImage} style={{ display: 'none' }} />
                  </label>
                )}
                {imageError && <div style={{ color: '#E76F51', fontSize: 12, marginTop: 6 }}>{imageError}</div>}
              </div>

              <div>
                <label style={lbl}>Header gradient</label>
                <p style={{ fontSize: 11, color: '#999', margin: '0 0 8px' }}>
                  Only shown when there is no Link Image. Leave off to auto-derive the color from the restaurant&apos;s logo/photo (falling back to the generic Disco gradient).
                </p>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: DARK, cursor: 'pointer', marginBottom: gradEnabled ? 12 : 0 }}>
                  <input type="checkbox" checked={gradEnabled} onChange={e => setGradEnabled(e.target.checked)} />
                  Use a custom header gradient
                </label>
                {gradEnabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#666' }}>
                      Start <input type="color" value={gradStart} onChange={e => setGradStart(e.target.value)} style={{ width: 40, height: 28, border: '1px solid #ddd', borderRadius: 6, background: 'none', cursor: 'pointer' }} />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#666' }}>
                      End <input type="color" value={gradEnd} onChange={e => setGradEnd(e.target.value)} style={{ width: 40, height: 28, border: '1px solid #ddd', borderRadius: 6, background: 'none', cursor: 'pointer' }} />
                    </label>
                    <div style={{ flex: 1, height: 32, borderRadius: 8, border: '1px solid #eee', background: `linear-gradient(120deg, ${gradStart} 0%, ${gradEnd} 100%)` }} />
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={closeDialog} disabled={saving}
                style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }}>
                Cancel
              </button>
              <button onClick={saveLink} disabled={saving || !editing.url || !editing.header || noLocations}
                style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: (saving || !editing.url || !editing.header || noLocations) ? 0.6 : 1 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const btnLink: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4, fontWeight: 600 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }
const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: INDIGO, padding: '2px 4px', fontFamily: F }
