'use client'
import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import 'react-quill-new/dist/quill.snow.css'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const PAGE_BG = '#F7F8FC'
const FM_BASE = process.env.NEXT_PUBLIC_FM_PUBLIC_BASE || 'https://api.familymeal.com'

// Quill must be client-only — its module loader breaks SSR
const ReactQuill = dynamic(() => import('react-quill-new'), { ssr: false, loading: () => <div style={{ minHeight: 180, background: '#fafafa', borderRadius: 8 }} /> })

const QUILL_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline', 'strike'],
    [{ header: 1 }, { header: 2 }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ indent: '-1' }, { indent: '+1' }],
    [{ size: ['small', false, 'large', 'huge'] }],
    [{ header: [1, 2, 3, 4, 5, 6, false] }],
    [{ color: [] }, { background: [] }],
    [{ font: [] }],
    [{ align: [] }],
    ['link'],
  ],
}

// ── Section DTO types ────────────────────────────────────────────────────────
interface Section1 { firstHeading: string; lastHeading: string; description: string; buttonText: string; url: string; urlText: string; layoutId: 'heroSectionDto' }
interface IconBox { iconHeading: string; iconDescription: string; icon: string }
interface Section2 { heading: string; iconDataList: IconBox[]; layoutId: 'threeColumnDto' }
interface Section3 { heading: string; image: string; starredText: string; buttonText: string; bulletPoints: string[]; layoutId: 'fullWidthCtaDto' }
interface Section4 { heading: string; iconDtoList: IconBox[]; layoutId: 'fourColumnDto' }
interface Section5 { heading: string; image: string; description: string; buttonText: string; layoutId: 'ctaBannerDto' }
interface FaqItem { faqHeading: string; faqDescription: string }
interface Section6 { heading: string; faqsDtoList: FaqItem[]; layoutId: 'faqsDto' }
interface Section7 { heading: string; headingTagLine: string; buttonText: string; image: string; steps: string[]; layoutId: 'processBoxDto' }
interface Section8 { iconsList: string[]; layoutId: 'marqueeIconsDto' }

interface ContentDoc {
  section_1: Section1; section_2: Section2; section_3: Section3; section_4: Section4
  section_5: Section5; section_6: Section6; section_7: Section7; section_8: Section8
}

function emptyDoc(): ContentDoc {
  return {
    section_1: { firstHeading: '', lastHeading: '', description: '', buttonText: '', url: '', urlText: '', layoutId: 'heroSectionDto' },
    section_2: { heading: '', iconDataList: padIcons([]), layoutId: 'threeColumnDto' },
    section_3: { heading: '', image: '', starredText: '', buttonText: '', bulletPoints: [''], layoutId: 'fullWidthCtaDto' },
    section_4: { heading: '', iconDtoList: padIcons([], 4), layoutId: 'fourColumnDto' },
    section_5: { heading: '', image: '', description: '', buttonText: '', layoutId: 'ctaBannerDto' },
    section_6: { heading: '', faqsDtoList: [{ faqHeading: '', faqDescription: '' }], layoutId: 'faqsDto' },
    section_7: { heading: '', headingTagLine: '', buttonText: '', image: '', steps: [''], layoutId: 'processBoxDto' },
    section_8: { iconsList: [], layoutId: 'marqueeIconsDto' },
  }
}
function padIcons(arr: IconBox[], n = 3): IconBox[] {
  const out = [...arr]
  while (out.length < n) out.push({ iconHeading: '', iconDescription: '', icon: '' })
  return out
}

// Local image refs may be either a server "reference" (UUID-ish) or a data: URL
// for pending uploads. We tag pending refs with a 'pending:' prefix internally.
type ImgRef = string

interface PendingFile { tag: string; file: File }

function imageDownloadUrl(ref: string, size = 400) {
  if (!ref) return ''
  if (ref.startsWith('data:') || ref.startsWith('pending:')) {
    // Data URL stored inline (pending uploads)
    return ref.startsWith('pending:') ? '' : ref
  }
  return `${FM_BASE}/public-api/images/${ref}/download?size=${size}`
}

export default function ContentManagementPage() {
  const [doc, setDoc] = useState<ContentDoc>(emptyDoc())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const pending = useRef<Map<string, PendingFile>>(new Map())   // tag → {file}
  const dataUrls = useRef<Map<string, string>>(new Map())       // tag → data URL for preview

  useEffect(() => {
    fetch('/api/admin/content-management')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && typeof data === 'object') {
          // Server may return partial — merge with empty so all fields exist
          const e = emptyDoc()
          const merged: ContentDoc = {
            section_1: { ...e.section_1, ...(data.section_1 || {}) },
            section_2: { ...e.section_2, ...(data.section_2 || {}), iconDataList: padIcons((data.section_2?.iconDataList) || [], 3) },
            section_3: { ...e.section_3, ...(data.section_3 || {}), bulletPoints: (data.section_3?.bulletPoints && data.section_3.bulletPoints.length) ? data.section_3.bulletPoints : [''] },
            section_4: { ...e.section_4, ...(data.section_4 || {}), iconDtoList: padIcons((data.section_4?.iconDtoList) || [], 4) },
            section_5: { ...e.section_5, ...(data.section_5 || {}) },
            section_6: { ...e.section_6, ...(data.section_6 || {}), faqsDtoList: (data.section_6?.faqsDtoList && data.section_6.faqsDtoList.length) ? data.section_6.faqsDtoList : [{ faqHeading: '', faqDescription: '' }] },
            section_7: { ...e.section_7, ...(data.section_7 || {}), steps: (data.section_7?.steps && data.section_7.steps.length) ? data.section_7.steps : [''] },
            section_8: { ...e.section_8, ...(data.section_8 || {}), iconsList: (data.section_8?.iconsList) || [] },
          }
          setDoc(merged)
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2800) }

  function takeImage(file: File): ImgRef {
    const tag = `pending:${Math.random().toString(36).slice(2)}-${Date.now()}`
    pending.current.set(tag, { tag, file })
    return tag
  }

  // Read file → data URL so we can show a preview before upload
  async function takeImageWithPreview(file: File): Promise<ImgRef> {
    const tag = takeImage(file)
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = reject
      fr.readAsDataURL(file)
    })
    dataUrls.current.set(tag, dataUrl)
    return tag
  }

  function previewSrc(ref: ImgRef): string {
    if (!ref) return ''
    if (ref.startsWith('pending:')) return dataUrls.current.get(ref) || ''
    return imageDownloadUrl(ref)
  }

  async function save() {
    setSaving(true); setError('')
    try {
      // Collect all pending image tags referenced in the current doc
      const tagsInDoc = collectTags(doc)
      const tagsToUpload = [...pending.current.keys()].filter(t => tagsInDoc.has(t))

      // Upload all pending images in a single multipart request
      const refByTag = new Map<string, string>()
      if (tagsToUpload.length) {
        const fd = new FormData()
        for (const t of tagsToUpload) {
          const p = pending.current.get(t)!
          fd.append('file', p.file, p.file.name)
        }
        const res = await fetch('/api/admin/images', { method: 'POST', body: fd })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d?.error || 'Image upload failed')
        }
        const uploaded: { name?: string; reference: string }[] = await res.json()
        // FM returns references in upload order — align with our tags
        tagsToUpload.forEach((t, i) => {
          const r = uploaded[i]
          if (r?.reference) refByTag.set(t, r.reference)
        })
      }

      // Build payload with tags replaced by references
      const payload = swapTagsForRefs(doc, refByTag)
      const res = await fetch('/api/admin/content-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || 'Save failed')
      }
      // Refresh state from server to get the now-persisted references
      const fresh = await fetch('/api/admin/content-management').then(r => r.ok ? r.json() : null)
      if (fresh) setDoc((prev) => mergeFresh(prev, fresh))
      // Clear pending
      pending.current.clear()
      dataUrls.current.clear()
      showToast('Content saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return <div style={{ padding: '28px 32px', fontFamily: F, color: '#888' }}>Loading content…</div>

  const setS1 = (patch: Partial<Section1>) => setDoc(d => ({ ...d, section_1: { ...d.section_1, ...patch } }))
  const setS2 = (patch: Partial<Section2>) => setDoc(d => ({ ...d, section_2: { ...d.section_2, ...patch } }))
  const setS3 = (patch: Partial<Section3>) => setDoc(d => ({ ...d, section_3: { ...d.section_3, ...patch } }))
  const setS4 = (patch: Partial<Section4>) => setDoc(d => ({ ...d, section_4: { ...d.section_4, ...patch } }))
  const setS5 = (patch: Partial<Section5>) => setDoc(d => ({ ...d, section_5: { ...d.section_5, ...patch } }))
  const setS6 = (patch: Partial<Section6>) => setDoc(d => ({ ...d, section_6: { ...d.section_6, ...patch } }))
  const setS7 = (patch: Partial<Section7>) => setDoc(d => ({ ...d, section_7: { ...d.section_7, ...patch } }))
  const setS8 = (patch: Partial<Section8>) => setDoc(d => ({ ...d, section_8: { ...d.section_8, ...patch } }))

  async function setIconAt(field: 'section_2' | 'section_4', i: number, file: File | null) {
    const ref = file ? await takeImageWithPreview(file) : ''
    setDoc(d => {
      if (field === 'section_2') {
        const next = [...d.section_2.iconDataList]
        next[i] = { ...next[i], icon: ref }
        return { ...d, section_2: { ...d.section_2, iconDataList: next } }
      }
      const next = [...d.section_4.iconDtoList]
      next[i] = { ...next[i], icon: ref }
      return { ...d, section_4: { ...d.section_4, iconDtoList: next } }
    })
  }

  async function pickHeroImage(file: File) {
    const ref = await takeImageWithPreview(file)
    setS1({ url: ref })
  }
  async function pickS3Image(file: File) {
    const ref = await takeImageWithPreview(file)
    setS3({ image: ref })
  }
  async function pickS5Image(file: File) {
    const ref = await takeImageWithPreview(file)
    setS5({ image: ref })
  }
  async function pickS7Image(file: File) {
    const ref = await takeImageWithPreview(file)
    setS7({ image: ref })
  }
  async function appendMarqueeImages(files: FileList) {
    const refs: string[] = []
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/')) refs.push(await takeImageWithPreview(f))
    }
    if (refs.length) setS8({ iconsList: [...doc.section_8.iconsList, ...refs] })
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, position: 'sticky', top: 0, background: PAGE_BG, paddingBottom: 12, zIndex: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Content Management</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {error && <span style={{ color: '#c00', fontSize: 12 }}>{error}</span>}
          <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save all'}
          </button>
        </div>
      </div>

      {/* Section 1 — Hero */}
      <SectionCard title="1 — Hero">
        <Row>
          <Field label="First heading*"><input style={inputSt} value={doc.section_1.firstHeading} onChange={e => setS1({ firstHeading: e.target.value })} /></Field>
          <Field label="Last heading*"><input style={inputSt} value={doc.section_1.lastHeading} onChange={e => setS1({ lastHeading: e.target.value })} /></Field>
        </Row>
        <Field label="Description*"><textarea rows={4} style={textSt} value={doc.section_1.description} onChange={e => setS1({ description: e.target.value })} /></Field>
        <Row>
          <Field label="Button text* (max 15)"><input style={inputSt} maxLength={15} value={doc.section_1.buttonText} onChange={e => setS1({ buttonText: e.target.value })} /></Field>
          <Field label="URL text*"><input style={inputSt} value={doc.section_1.urlText} onChange={e => setS1({ urlText: e.target.value })} /></Field>
        </Row>
        <ImagePicker label="Background image*" ref_={doc.section_1.url} previewSrc={previewSrc(doc.section_1.url)} onPick={pickHeroImage} onClear={() => setS1({ url: '' })} />
      </SectionCard>

      {/* Section 2 — 3-column */}
      <SectionCard title="2 — Three Value Boxes">
        <Field label="Heading*"><input style={inputSt} value={doc.section_2.heading} onChange={e => setS2({ heading: e.target.value })} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {doc.section_2.iconDataList.map((it, i) => (
            <IconBoxEditor key={i} item={it} previewSrc={previewSrc(it.icon)} onChange={(p) => {
              const next = [...doc.section_2.iconDataList]
              next[i] = { ...next[i], ...p }
              setS2({ iconDataList: next })
            }} onPickIcon={(f) => setIconAt('section_2', i, f)} />
          ))}
        </div>
      </SectionCard>

      {/* Section 3 — Full-width CTA / Pricing */}
      <SectionCard title="3 — Pricing">
        <Field label="Heading*"><input style={inputSt} value={doc.section_3.heading} onChange={e => setS3({ heading: e.target.value })} /></Field>
        <Row>
          <Field label="Starred text*"><input style={inputSt} value={doc.section_3.starredText} onChange={e => setS3({ starredText: e.target.value })} /></Field>
          <Field label="Button text* (max 15)"><input style={inputSt} maxLength={15} value={doc.section_3.buttonText} onChange={e => setS3({ buttonText: e.target.value })} /></Field>
        </Row>
        <ImagePicker label="Image*" ref_={doc.section_3.image} previewSrc={previewSrc(doc.section_3.image)} onPick={pickS3Image} onClear={() => setS3({ image: '' })} />
        <RepeatList
          label="Bullet points"
          items={doc.section_3.bulletPoints}
          onAdd={() => setS3({ bulletPoints: [...doc.section_3.bulletPoints, ''] })}
          onChange={(i, v) => { const next = [...doc.section_3.bulletPoints]; next[i] = v; setS3({ bulletPoints: next }) }}
          onRemove={(i) => setS3({ bulletPoints: doc.section_3.bulletPoints.filter((_, x) => x !== i) })}
        />
      </SectionCard>

      {/* Section 4 — 4-column tech specs */}
      <SectionCard title="4 — Tech Specifications">
        <Field label="Heading*"><input style={inputSt} value={doc.section_4.heading} onChange={e => setS4({ heading: e.target.value })} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          {doc.section_4.iconDtoList.map((it, i) => (
            <IconBoxEditor key={i} item={it} previewSrc={previewSrc(it.icon)} onChange={(p) => {
              const next = [...doc.section_4.iconDtoList]
              next[i] = { ...next[i], ...p }
              setS4({ iconDtoList: next })
            }} onPickIcon={(f) => setIconAt('section_4', i, f)}
            removable={i >= 4}
            onRemove={() => setS4({ iconDtoList: doc.section_4.iconDtoList.filter((_, x) => x !== i) })}
            />
          ))}
        </div>
        <button onClick={() => setS4({ iconDtoList: [...doc.section_4.iconDtoList, { iconHeading: '', iconDescription: '', icon: '' }] })} style={{ ...secondaryBtn, marginTop: 10 }}>+ Add icon box</button>
      </SectionCard>

      {/* Section 5 — CTA Banner */}
      <SectionCard title="5 — Marketplace Teaser">
        <Field label="Heading*"><input style={inputSt} value={doc.section_5.heading} onChange={e => setS5({ heading: e.target.value })} /></Field>
        <Field label="Description*"><textarea rows={4} style={textSt} value={doc.section_5.description} onChange={e => setS5({ description: e.target.value })} /></Field>
        <Row>
          <Field label="Button text* (max 15)"><input style={inputSt} maxLength={15} value={doc.section_5.buttonText} onChange={e => setS5({ buttonText: e.target.value })} /></Field>
          <div />
        </Row>
        <ImagePicker label="Image*" ref_={doc.section_5.image} previewSrc={previewSrc(doc.section_5.image)} onPick={pickS5Image} onClear={() => setS5({ image: '' })} />
      </SectionCard>

      {/* Section 6 — FAQs */}
      <SectionCard title="6 — FAQ">
        <Field label="Heading*"><input style={inputSt} value={doc.section_6.heading} onChange={e => setS6({ heading: e.target.value })} /></Field>
        {doc.section_6.faqsDtoList.map((it, i) => (
          <div key={i} style={{ padding: 14, border: '1px solid #eee', borderRadius: 10, marginBottom: 12, background: '#fcfcff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: '#888', fontWeight: 700 }}>FAQ #{i + 1}</span>
              {i > 0 && <button onClick={() => setS6({ faqsDtoList: doc.section_6.faqsDtoList.filter((_, x) => x !== i) })} style={removeBtn}>Remove</button>}
            </div>
            <Field label="Question*"><input style={inputSt} value={it.faqHeading} onChange={e => {
              const next = [...doc.section_6.faqsDtoList]; next[i] = { ...next[i], faqHeading: e.target.value }; setS6({ faqsDtoList: next })
            }} /></Field>
            <Field label="Answer*">
              <ReactQuill
                theme="snow"
                value={it.faqDescription}
                modules={QUILL_MODULES}
                onChange={(value: string) => {
                  const next = [...doc.section_6.faqsDtoList]; next[i] = { ...next[i], faqDescription: value }; setS6({ faqsDtoList: next })
                }}
              />
            </Field>
          </div>
        ))}
        <button onClick={() => setS6({ faqsDtoList: [...doc.section_6.faqsDtoList, { faqHeading: '', faqDescription: '' }] })} style={secondaryBtn}>+ Add FAQ</button>
      </SectionCard>

      {/* Section 7 — Process / Become a Partner */}
      <SectionCard title="7 — Become a Partner">
        <Row>
          <Field label="Heading*"><input style={inputSt} value={doc.section_7.heading} onChange={e => setS7({ heading: e.target.value })} /></Field>
          <Field label="Tag line*"><input style={inputSt} value={doc.section_7.headingTagLine} onChange={e => setS7({ headingTagLine: e.target.value })} /></Field>
        </Row>
        <Field label="Button text* (max 15)"><input style={inputSt} maxLength={15} value={doc.section_7.buttonText} onChange={e => setS7({ buttonText: e.target.value })} /></Field>
        <ImagePicker label="Image*" ref_={doc.section_7.image} previewSrc={previewSrc(doc.section_7.image)} onPick={pickS7Image} onClear={() => setS7({ image: '' })} />
        <RepeatList
          label="Steps"
          items={doc.section_7.steps}
          onAdd={() => setS7({ steps: [...doc.section_7.steps, ''] })}
          onChange={(i, v) => { const next = [...doc.section_7.steps]; next[i] = v; setS7({ steps: next }) }}
          onRemove={(i) => setS7({ steps: doc.section_7.steps.filter((_, x) => x !== i) })}
        />
      </SectionCard>

      {/* Section 8 — Marquee */}
      <SectionCard title="8 — Partners (Marquee)">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          {doc.section_8.iconsList.map((ref, i) => (
            <div key={`${ref}-${i}`} style={{ position: 'relative', width: 88, height: 88, borderRadius: 10, overflow: 'hidden', border: '1px solid #eee', background: '#f7f7fb' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {previewSrc(ref) && <img src={previewSrc(ref)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              <button onClick={() => setS8({ iconsList: doc.section_8.iconsList.filter((_, x) => x !== i) })}
                style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff', borderRadius: 12, width: 22, height: 22, fontSize: 12, cursor: 'pointer' }}>×</button>
            </div>
          ))}
        </div>
        <label style={{ ...secondaryBtn, display: 'inline-block', cursor: 'pointer' }}>
          + Add images
          <input type="file" multiple accept="image/*" onChange={e => e.target.files && appendMarqueeImages(e.target.files)} style={{ display: 'none' }} />
        </label>
        <small style={{ display: 'block', color: '#888', fontSize: 11, marginTop: 8 }}>Min 1 image required.</small>
      </SectionCard>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, background: DARK, color: '#fff',
          padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 400,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>{toast}</div>
      )}

      <style>{`select:focus, input:focus, textarea:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; }`}</style>
    </div>
  )
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: 20, marginBottom: 18 }}>
      <h2 style={{ fontSize: 13, fontWeight: 700, color: '#666', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</h2>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>
}

function ImagePicker({ label, ref_, previewSrc, onPick, onClear }: {
  label: string; ref_: string; previewSrc: string;
  onPick: (file: File) => void; onClear: () => void
}) {
  return (
    <Field label={label}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, border: '1.5px dashed #ccc', borderRadius: 10, padding: 10 }}>
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewSrc} alt="" style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 6 }} />
        ) : (
          <div style={{ width: 84, height: 84, background: '#f3f3f6', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: 11 }}>none</div>
        )}
        <label style={{ ...secondaryBtn, cursor: 'pointer' }}>
          {ref_ ? 'Replace' : 'Choose image'}
          <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }} style={{ display: 'none' }} />
        </label>
        {ref_ && <button onClick={onClear} style={removeBtn}>Remove</button>}
      </div>
    </Field>
  )
}

function IconBoxEditor({ item, previewSrc, onChange, onPickIcon, removable, onRemove }: {
  item: IconBox; previewSrc: string;
  onChange: (p: Partial<IconBox>) => void;
  onPickIcon: (f: File) => void;
  removable?: boolean; onRemove?: () => void;
}) {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, background: '#fcfcff', position: 'relative' }}>
      {removable && (
        <button onClick={onRemove} style={{ position: 'absolute', top: 6, right: 6, background: 'transparent', border: 'none', color: '#c00', fontSize: 11, cursor: 'pointer' }}>Remove</button>
      )}
      <Field label="Icon heading*"><input style={inputSt} value={item.iconHeading} onChange={e => onChange({ iconHeading: e.target.value })} /></Field>
      <Field label="Description*"><textarea rows={3} style={textSt} value={item.iconDescription} onChange={e => onChange({ iconDescription: e.target.value })} /></Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewSrc} alt="" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 6, background: '#fff', border: '1px solid #eee' }} />
        ) : (
          <div style={{ width: 48, height: 48, background: '#f3f3f6', borderRadius: 6 }} />
        )}
        <label style={{ ...secondaryBtn, cursor: 'pointer', fontSize: 11, padding: '6px 10px' }}>
          {item.icon ? 'Replace' : 'Icon'}
          <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) onPickIcon(f); e.target.value = '' }} style={{ display: 'none' }} />
        </label>
      </div>
    </div>
  )
}

function RepeatList({ label, items, onAdd, onChange, onRemove }: {
  label: string; items: string[];
  onAdd: () => void; onChange: (i: number, v: string) => void; onRemove: (i: number) => void
}) {
  return (
    <Field label={label}>
      {items.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <input style={{ ...inputSt, flex: 1 }} value={v} onChange={e => onChange(i, e.target.value)} />
          {i > 0 && <button onClick={() => onRemove(i)} style={removeBtn}>×</button>}
        </div>
      ))}
      <button onClick={onAdd} style={{ ...secondaryBtn, fontSize: 12, padding: '6px 12px' }}>+ Add</button>
    </Field>
  )
}

// ── Save helpers ──────────────────────────────────────────────────────────────

function collectTags(d: ContentDoc): Set<string> {
  const out = new Set<string>()
  const consider = (s: string | undefined) => { if (s && s.startsWith('pending:')) out.add(s) }
  consider(d.section_1.url)
  d.section_2.iconDataList.forEach(b => consider(b.icon))
  consider(d.section_3.image)
  d.section_4.iconDtoList.forEach(b => consider(b.icon))
  consider(d.section_5.image)
  consider(d.section_7.image)
  d.section_8.iconsList.forEach(consider)
  return out
}

function swap(s: string, map: Map<string, string>): string {
  if (s && s.startsWith('pending:')) return map.get(s) || ''
  return s
}

function swapTagsForRefs(d: ContentDoc, map: Map<string, string>): ContentDoc {
  return {
    section_1: { ...d.section_1, url: swap(d.section_1.url, map) },
    section_2: { ...d.section_2, iconDataList: d.section_2.iconDataList.map(b => ({ ...b, icon: swap(b.icon, map) })) },
    section_3: { ...d.section_3, image: swap(d.section_3.image, map) },
    section_4: { ...d.section_4, iconDtoList: d.section_4.iconDtoList.map(b => ({ ...b, icon: swap(b.icon, map) })) },
    section_5: { ...d.section_5, image: swap(d.section_5.image, map) },
    section_6: d.section_6,
    section_7: { ...d.section_7, image: swap(d.section_7.image, map) },
    section_8: { ...d.section_8, iconsList: d.section_8.iconsList.map(r => swap(r, map)).filter(Boolean) },
  }
}

function mergeFresh(prev: ContentDoc, fresh: Partial<ContentDoc>): ContentDoc {
  // Replace fields whose values are now real references; preserve user-side
  // structure for arrays (length, ordering).
  const out: ContentDoc = { ...prev }
  if (fresh.section_1) out.section_1 = { ...prev.section_1, ...fresh.section_1 }
  if (fresh.section_2) out.section_2 = { ...prev.section_2, ...fresh.section_2, iconDataList: padIcons(fresh.section_2.iconDataList || [], 3) }
  if (fresh.section_3) out.section_3 = { ...prev.section_3, ...fresh.section_3 }
  if (fresh.section_4) out.section_4 = { ...prev.section_4, ...fresh.section_4, iconDtoList: padIcons(fresh.section_4.iconDtoList || [], 4) }
  if (fresh.section_5) out.section_5 = { ...prev.section_5, ...fresh.section_5 }
  if (fresh.section_6) out.section_6 = { ...prev.section_6, ...fresh.section_6 }
  if (fresh.section_7) out.section_7 = { ...prev.section_7, ...fresh.section_7 }
  if (fresh.section_8) out.section_8 = { ...prev.section_8, ...fresh.section_8 }
  return out
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' }
const textSt: React.CSSProperties = { ...inputSt, resize: 'vertical', minHeight: 90, lineHeight: 1.5 }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: GOLD, color: '#1A1028', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }
const secondaryBtn: React.CSSProperties = { padding: '8px 14px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: F, color: DARK }
const removeBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: '#c00', fontSize: 12, cursor: 'pointer', fontFamily: F, padding: '4px 6px' }
