'use client'
// Menu Builder (Peter, 25 Oct 2026): an AI tool that builds and updates menus
// from uploaded files. Super Admin only, and of those only Peter and Kealoha —
// enforced by every /api/admin/menu-builder route; this page only shows what
// they return. See lib/menu-builder/ for how it works and what it may write.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { upload } from '@vercel/blob/client'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'
const MUTED = '#6B6880'
const BORDER = '#E6E4EE'
const GREEN = '#1F8A4C'
const RED = '#C0392B'

type Option = { name: string; price: number }
type Group = { ref: string | null; name: string; title: string; subtitle: string | null; min: number; max: number; options: Option[] }
type Item = { ref: string | null; name: string; description: string | null; price: number; display_price: string | null; serves: string | null; min_quantity: number | null; image: string | null; vegetarian: boolean; vegan: boolean; gluten_free: boolean; dairy_free: boolean; contains_nuts: boolean; option_groups: Group[] }
type Category = { ref: string | null; name: string; description: string | null; items: Item[] }
type Settings = Record<string, unknown> & { windows: { day: string; from: string; to: string }[] }
type Spec = { name: string; type: string; description: string | null; settings: Settings; categories: Category[] }
type Msg = { role: 'user' | 'assistant'; text: string; questions?: string[]; choices?: string[]; at: string }
type Change = { where: string; field: string; before: string; after: string }
type Plan = { restaurantRef: string; menuRef: string; changes: Change[] }
type Session = {
  reference: string; actor_email: string; mode: 'new' | 'update'; restaurant_refs: string[]; restaurant_names: string[]
  target_menu_name: string | null; status: string; status_note: string | null
  files: { name: string; type: string; size: number; kind?: string; note?: string }[]
  transcript: string | null; images: { name: string; url: string }[]; messages: Msg[]
  pending_diff: { plans: Plan[] } | null; result: Record<string, unknown> | null
  api_calls: { at: string; purpose: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number }[]
  input_tokens: number; output_tokens: number; cost_usd: number; created_at: string
}
type Detail = { session: Session; draft: { reference: string; visible: boolean; spec: Spec } | null; photoReport: { itemsWithoutPhoto: string[]; photosWithoutItem: string[] } | null }

const money = (n: number) => `$${Number(n).toFixed(2)}`
const cost = (n: number) => `$${Number(n).toFixed(2)}`
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16 }
const btn = (bg = DARK, fg = '#fff'): React.CSSProperties => ({ background: bg, color: fg, border: 'none', borderRadius: 8, padding: '9px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: F })
const input: React.CSSProperties = { width: '100%', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '9px 11px', fontSize: 13, fontFamily: F, boxSizing: 'border-box' }

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) }, cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

export default function MenuBuilderRoute() {
  return <Suspense fallback={null}><MenuBuilderPage /></Suspense>
}

function MenuBuilderPage() {
  const router = useRouter()
  const params = useSearchParams()
  const sessionRef = params.get('s')
  const tab = params.get('tab') || (sessionRef ? 'session' : 'new')
  const [denied, setDenied] = useState<string | null>(null)
  const go = (q: string) => router.push(`/admin/menu-builder${q}`)

  if (denied) return <Shell><div style={{ ...card, color: RED, fontWeight: 600 }}>{denied}</div></Shell>
  return (
    <Shell>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {[['new', 'New session'], ['sessions', 'Sessions'], ['rules', 'Builder Rules']].map(([k, label]) => (
          <button key={k} onClick={() => go(k === 'new' ? '' : `?tab=${k}`)}
            style={{ ...btn(tab === k ? DARK : '#fff', tab === k ? '#fff' : DARK), border: `1px solid ${tab === k ? DARK : BORDER}` }}>{label}</button>
        ))}
      </div>
      {tab === 'new' && <NewSession onDenied={setDenied} onStarted={r => go(`?s=${r}`)} />}
      {tab === 'session' && sessionRef && <SessionView reference={sessionRef} onDenied={setDenied} />}
      {tab === 'sessions' && <Sessions onDenied={setDenied} onOpen={r => go(`?s=${r}`)} />}
      {tab === 'rules' && <Rules onDenied={setDenied} />}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: F, background: PAGE_BG, minHeight: '100vh', padding: '24px 20px', color: DARK }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>Menu Builder</h1>
      <p style={{ margin: '0 0 18px', color: MUTED, fontSize: 13 }}>Builds and updates menus from your files. New menus stay hidden until you press Publish; updates are saved only when you confirm the changes.</p>
      {children}
    </div>
  )
}

// ── New session ─────────────────────────────────────────────────────────────
type Rest = { reference: string; name: string; city?: string | null; state?: string | null }

function NewSession({ onDenied, onStarted }: { onDenied: (m: string) => void; onStarted: (ref: string) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Rest[]>([])
  const [chosen, setChosen] = useState<Rest[]>([])
  const [mode, setMode] = useState<'new' | 'update'>('new')
  const [menus, setMenus] = useState<{ reference: string; name: string; visible: boolean; archived: boolean }[]>([])
  const [targetMenu, setTargetMenu] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const addFiles = (list: FileList | null) => { const picked = Array.from(list || []); setFiles(prev => [...prev, ...picked]) }
  const [links, setLinks] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      const r = await api<{ restaurants: Rest[] }>(`/api/admin/menu-builder/restaurants?q=${encodeURIComponent(q.trim())}`)
      if (r.status === 403 || r.status === 401) return onDenied(r.data.error || 'Not authorized')
      setResults(r.data.restaurants || [])
    }, 250)
    return () => clearTimeout(t)
  }, [q, onDenied])

  useEffect(() => {
    setTargetMenu('')
    if (mode !== 'update' || !chosen[0]) { setMenus([]); return }
    api<{ menus: typeof menus }>(`/api/admin/menu-builder/restaurants?menus=${chosen[0].reference}`).then(r => setMenus(r.data.menus || []))
  }, [mode, chosen])

  async function start() {
    setErr(null)
    if (!chosen.length) return setErr('Pick at least one location.')
    if (mode === 'update' && !targetMenu) return setErr('Pick the menu to update.')
    const sheetLinks = links.split(/\s+/).map(s => s.trim()).filter(Boolean)
    if (!files.length && !sheetLinks.length && !prompt.trim()) return setErr('Add files, a Google Sheet link, or instructions.')
    try {
      const uploads: { name: string; url: string; size: number; contentType: string }[] = []
      for (const [i, f] of files.entries()) {
        setBusy(`Uploading ${i + 1} of ${files.length}: ${f.name}`)
        const safe = f.name.replace(/[^\w.\- ]+/g, '_')
        const b = await upload(`menu-builder-uploads/${crypto.randomUUID()}/${safe}`, f, { access: 'public', handleUploadUrl: '/api/admin/menu-builder/upload', multipart: f.size > 8 * 1024 * 1024 })
        uploads.push({ name: f.name, url: b.url, size: f.size, contentType: f.type })
      }
      setBusy('Starting…')
      const r = await api<{ reference: string }>('/api/admin/menu-builder/sessions', {
        method: 'POST', body: JSON.stringify({ mode, restaurantRefs: chosen.map(c => c.reference), targetMenuRef: targetMenu || null, prompt, uploads, sheetLinks }),
      })
      if (r.status === 403 || r.status === 401) return onDenied(r.data.error || 'Not authorized')
      if (!r.ok) throw new Error(r.data.error || 'Could not start')
      onStarted(r.data.reference)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 820 }}>
      <div style={card}>
        <Label>1. Locations</Label>
        <input style={input} placeholder="Search Disco-native restaurants…" value={q} onChange={e => setQ(e.target.value)} />
        {results.length > 0 && (
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, marginTop: 6, maxHeight: 220, overflow: 'auto' }}>
            {results.filter(r => !chosen.some(c => c.reference === r.reference)).map(r => (
              <div key={r.reference} onClick={() => { setChosen([...chosen, r]); setQ(''); setResults([]) }}
                style={{ padding: '8px 11px', cursor: 'pointer', fontSize: 13, borderBottom: `1px solid ${BORDER}` }}>
                {r.name}{r.city ? <span style={{ color: MUTED }}> · {r.city}{r.state ? `, ${r.state}` : ''}</span> : null}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {chosen.map((c, i) => (
            <span key={c.reference} style={{ background: i === 0 ? '#FFF4DA' : '#F0EFF6', borderRadius: 16, padding: '5px 10px', fontSize: 12 }}>
              {c.name}{i === 0 ? ' (built here first)' : ''}
              <span onClick={() => setChosen(chosen.filter(x => x.reference !== c.reference))} style={{ marginLeft: 8, cursor: 'pointer', color: MUTED }}>×</span>
            </span>
          ))}
        </div>
      </div>
      <div style={card}>
        <Label>2. What to do</Label>
        <div style={{ display: 'flex', gap: 18, fontSize: 13, flexWrap: 'wrap' }}>
          <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Build a new menu</label>
          <label><input type="radio" checked={mode === 'update'} onChange={() => setMode('update')} /> Update an existing menu</label>
        </div>
        {mode === 'update' && (
          <select style={{ ...input, marginTop: 10 }} value={targetMenu} onChange={e => setTargetMenu(e.target.value)} disabled={!chosen.length}>
            <option value="">{chosen.length ? `Menu at ${chosen[0].name}…` : 'Pick a location first'}</option>
            {menus.map(m => <option key={m.reference} value={m.reference}>{m.name}{m.archived ? ' (archived)' : m.visible ? '' : ' (hidden)'}</option>)}
          </select>
        )}
        {mode === 'update' && chosen.length > 1 && <p style={{ fontSize: 12, color: MUTED, margin: '6px 0 0' }}>The other locations must have a menu with the same name; each gets the same change.</p>}
      </div>
      <div style={card}>
        <Label>3. Files</Label>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 10px' }}>PDFs, images, ZIPs, spreadsheets or Word files.</p>
        <input ref={fileInput} type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.zip,.xlsx,.xlsm,.csv,.tsv,.txt,.docx,image/*"
          onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
        <button type="button" onClick={() => fileInput.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
          style={{ width: '100%', padding: '26px 16px', borderRadius: 12, border: `2px dashed ${dragging ? BLUE : BORDER}`, background: dragging ? '#EEF0FF' : PAGE_BG, cursor: 'pointer', fontFamily: F, color: DARK }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Upload files</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>or drag and drop them here</div>
        </button>
        {files.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {files.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '6px 0', borderBottom: i < files.length - 1 ? `1px solid ${BORDER}` : 'none' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: MUTED, fontSize: 18, lineHeight: 1, padding: '0 4px' }}>×</button>
              </div>
            ))}
          </div>
        )}
        <Label style={{ marginTop: 14 }}>Google Sheet links</Label>
        <input style={input} value={links} onChange={e => setLinks(e.target.value)} placeholder="https://docs.google.com/spreadsheets/…" />
      </div>
      <div style={card}>
        <Label>4. Instructions</Label>
        <textarea style={{ ...input, minHeight: 110 }} value={prompt} onChange={e => setPrompt(e.target.value)}
          placeholder={mode === 'new' ? 'e.g. Thanksgiving catering menu, pickup Wed Nov 25 12–4 PM, order by Sat Nov 21 5 PM. Copy last year’s Thanksgiving menu’s structure.' : 'e.g. Raise all half trays $5.'} />
      </div>
      {err && <div style={{ color: RED, fontSize: 13 }}>{err}</div>}
      <div><button style={btn(GOLD, DARK)} onClick={start} disabled={!!busy}>{busy || 'Start'}</button></div>
    </div>
  )
}

function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: MUTED, marginBottom: 8, ...style }}>{children}</div>
}

// ── Session ─────────────────────────────────────────────────────────────────
function SessionView({ reference, onDenied }: { reference: string; onDenied: (m: string) => void }) {
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [arm, setArm] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const r = await api<Detail>(`/api/admin/menu-builder/sessions/${reference}`)
    if (r.status === 403 || r.status === 401) return onDenied(r.data.error || 'Not authorized')
    if (!r.ok) return setErr(r.data.error || 'Could not load')
    setD(r.data)
  }, [reference, onDenied])

  useEffect(() => { load() }, [load])
  const working = d?.session.status === 'working'
  useEffect(() => {
    if (!working) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [working, load])
  const msgCount = d?.session.messages.length
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [msgCount])

  async function post(path: string, body?: unknown) {
    setErr(null); setPosting(true)
    const r = await api(`/api/admin/menu-builder/sessions/${reference}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
    setPosting(false); setArm(null)
    if (r.status === 403 || r.status === 401) return onDenied(r.data.error || 'Not authorized')
    if (!r.ok) setErr(r.data.error || 'Failed')
    await load()
  }
  async function send(t: string) {
    if (!t.trim()) return
    setText('')
    await post('message', { text: t })
  }

  if (!d) return <div style={card}>{err || 'Loading…'}</div>
  const s = d.session
  const finished = ['published', 'applied', 'discarded'].includes(s.status)
  const canAct = !working && !finished && !posting
  const plans = s.pending_diff?.plans || []

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', fontSize: 13 }}>
        <div><b>{s.mode === 'new' ? 'New menu' : `Update “${s.target_menu_name}”`}</b> · {s.restaurant_names.join(', ')}</div>
        <Status s={s} />
        <div style={{ color: MUTED }}>by {s.actor_email} · {new Date(s.created_at).toLocaleString()}</div>
        <div style={{ marginLeft: 'auto', fontWeight: 700 }} title={`${s.input_tokens.toLocaleString()} input / ${s.output_tokens.toLocaleString()} output tokens`}>API cost: {cost(s.cost_usd)}</div>
      </div>
      {err && <div style={{ color: RED, fontSize: 13 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', maxHeight: '78vh' }}>
          <Label>Chat</Label>
          <div style={{ overflow: 'auto', flex: 1, display: 'grid', gap: 10, paddingRight: 4 }}>
            {s.messages.map((m, i) => <Bubble key={i} m={m} />)}
            {working && <div style={{ color: MUTED, fontSize: 13, fontStyle: 'italic' }}>{s.status_note || 'Working…'}</div>}
            {s.status === 'error' && <div style={{ color: RED, fontSize: 13 }}>{s.status_note}</div>}
            <div ref={bottom} />
          </div>
          {!finished && (
            <div style={{ marginTop: 10 }}>
              <textarea style={{ ...input, minHeight: 70 }} value={text} onChange={e => setText(e.target.value)} disabled={!canAct}
                placeholder="Answer the questions (by number), ask for changes, or say “build it”." />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button style={btn()} disabled={!canAct || !text.trim()} onClick={() => send(text)}>Send</button>
                <button style={btn('#fff', DARK)} disabled={!canAct} onClick={() => send(s.mode === 'new'
                  ? 'Build the draft now. Use your best judgement for anything I have not answered and list those choices.'
                  : 'Show me the changes now. Use your best judgement for anything I have not answered and list those choices.')}>
                  {s.mode === 'new' ? 'Build the draft now' : 'Show the changes now'}</button>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          {s.mode === 'new' && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <Label style={{ margin: 0 }}>Preview</Label>
                {d.draft && <span style={{ fontSize: 12, fontWeight: 700, color: d.draft.visible ? GREEN : '#9A6B00', background: d.draft.visible ? '#E6F5EC' : '#FFF4DA', padding: '3px 8px', borderRadius: 10 }}>
                  {d.draft.visible ? 'LIVE' : 'HIDDEN DRAFT — customers cannot see it'}</span>}
              </div>
              {!d.draft && <div style={{ fontSize: 13, color: MUTED }}>No draft yet. Answer the questions, then build.</div>}
              {d.draft && <MenuPreview spec={d.draft.spec} />}
              {d.photoReport && (d.photoReport.itemsWithoutPhoto.length > 0 || d.photoReport.photosWithoutItem.length > 0) && (
                <div style={{ marginTop: 12, fontSize: 12 }}>
                  {d.photoReport.itemsWithoutPhoto.length > 0 && <div><b>Items with no photo ({d.photoReport.itemsWithoutPhoto.length}):</b> {d.photoReport.itemsWithoutPhoto.join('; ')}</div>}
                  {d.photoReport.photosWithoutItem.length > 0 && <div style={{ marginTop: 4 }}><b>Photos with no item ({d.photoReport.photosWithoutItem.length}):</b> {d.photoReport.photosWithoutItem.join('; ')}</div>}
                </div>
              )}
              {d.draft && !finished && (
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  {arm === 'publish'
                    ? <><button style={btn(GREEN)} disabled={!canAct} onClick={() => post('publish')}>Yes, publish to {s.restaurant_names.length} location{s.restaurant_names.length === 1 ? '' : 's'}</button>
                        <button style={btn('#fff', DARK)} onClick={() => setArm(null)}>Cancel</button></>
                    : <button style={btn(GREEN)} disabled={!canAct} onClick={() => setArm('publish')}>Publish…</button>}
                  {arm === 'discard'
                    ? <><button style={btn(RED)} disabled={!canAct} onClick={() => post('discard')}>Yes, delete the draft</button><button style={btn('#fff', DARK)} onClick={() => setArm(null)}>Cancel</button></>
                    : <button style={btn('#fff', RED)} disabled={!canAct} onClick={() => setArm('discard')}>Discard draft</button>}
                </div>
              )}
              {d.draft && !finished && s.restaurant_names.length > 1 && <p style={{ fontSize: 12, color: MUTED, margin: '8px 0 0' }}>Publish copies this draft to {s.restaurant_names.slice(1).join(', ')}, checks every copy matches, then turns them all on together.</p>}
            </div>
          )}
          {s.mode === 'update' && (
            <div style={card}>
              <Label>Changes (nothing is saved until you confirm)</Label>
              {!plans.length && s.status !== 'applied' && <div style={{ fontSize: 13, color: MUTED }}>No changes proposed yet.</div>}
              {s.status === 'applied' && <div style={{ fontSize: 13, color: GREEN, fontWeight: 700 }}>Saved.</div>}
              {plans.map(p => (
                <div key={p.menuRef} style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, margin: '6px 0' }}>{s.restaurant_names[s.restaurant_refs.indexOf(p.restaurantRef)]} — {p.changes.length} change{p.changes.length === 1 ? '' : 's'}</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                      <thead><tr>{['Where', 'What', 'Before', 'After'].map(h => <th key={h} style={{ textAlign: 'left', borderBottom: `1px solid ${BORDER}`, padding: '5px 6px', color: MUTED }}>{h}</th>)}</tr></thead>
                      <tbody>{p.changes.map((c, i) => (
                        <tr key={i}><td style={td}>{c.where}</td><td style={td}>{c.field}</td><td style={{ ...td, color: RED }}>{c.before}</td><td style={{ ...td, color: GREEN }}>{c.after}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              ))}
              {plans.length > 0 && !finished && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {arm === 'confirm'
                    ? <><button style={btn(GREEN)} disabled={!canAct} onClick={() => post('confirm')}>Yes, save these changes</button><button style={btn('#fff', DARK)} onClick={() => setArm(null)}>Cancel</button></>
                    : <button style={btn(GREEN)} disabled={!canAct} onClick={() => setArm('confirm')}>Confirm and save…</button>}
                  <button style={btn('#fff', RED)} disabled={!canAct} onClick={() => post('discard')}>Discard</button>
                </div>
              )}
            </div>
          )}
          <div style={card}>
            <Label>Files</Label>
            {s.files.length === 0 && <div style={{ fontSize: 13, color: MUTED }}>None.</div>}
            {s.files.map((f, i) => (
              <div key={i} style={{ fontSize: 12, marginBottom: 4 }}><b>{f.name}</b>{f.kind ? ` · ${f.kind.replace(/_/g, ' ')}` : ''}{f.note ? <span style={{ color: MUTED }}> · {f.note}</span> : null}</div>
            ))}
            {s.transcript && <details style={{ marginTop: 8 }}><summary style={{ fontSize: 12, cursor: 'pointer' }}>What the builder read from the files</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: PAGE_BG, padding: 10, borderRadius: 8, maxHeight: 360, overflow: 'auto' }}>{s.transcript}</pre></details>}
          </div>
          <div style={card}>
            <Label>API cost</Label>
            <div style={{ fontSize: 12 }}>
              {s.api_calls.map((c, i) => <div key={i}>{new Date(c.at).toLocaleTimeString()} · {c.purpose} · {c.input_tokens.toLocaleString()} in / {c.output_tokens.toLocaleString()} out · <b>{cost(c.cost_usd)}</b></div>)}
              <div style={{ marginTop: 6, fontWeight: 700 }}>Total {cost(s.cost_usd)} ({s.api_calls[0]?.model || 'claude-opus-5-5'})</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const td: React.CSSProperties = { borderBottom: `1px solid ${BORDER}`, padding: '5px 6px', verticalAlign: 'top' }

function Status({ s }: { s: Session }) {
  const map: Record<string, [string, string]> = {
    working: ['Working…', BLUE], ready: ['Waiting for you', '#9A6B00'], error: ['Error', RED],
    published: ['Published', GREEN], applied: ['Changes saved', GREEN], discarded: ['Discarded', MUTED],
  }
  const [label, color] = map[s.status] || [s.status, MUTED]
  return <span style={{ color, fontWeight: 700 }}>{label}</span>
}

function Bubble({ m }: { m: Msg }) {
  const me = m.role === 'user'
  return (
    <div style={{ justifySelf: me ? 'end' : 'start', maxWidth: '92%', background: me ? '#F0EFF6' : '#FFFBF0', border: `1px solid ${me ? BORDER : '#F3E2B3'}`, borderRadius: 10, padding: '9px 12px', fontSize: 13, whiteSpace: 'pre-wrap' }}>
      {m.text}
      {m.choices && m.choices.length > 0 && (
        <details style={{ marginTop: 8 }} open><summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>Choices made ({m.choices.length})</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{m.choices.map((c, i) => <li key={i}>{c}</li>)}</ul></details>
      )}
      {m.questions && m.questions.length > 0 && (
        <div style={{ marginTop: 8 }}><b style={{ fontSize: 12 }}>Questions</b>
          <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>{m.questions.map((q, i) => <li key={i} style={{ marginBottom: 3 }}>{q}</li>)}</ol></div>
      )}
    </div>
  )
}

function MenuPreview({ spec }: { spec: Spec }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- settings read loosely for display
  const st = spec.settings as Record<string, any>
  const rows: [string, string][] = [
    ['Menu', `${spec.name} (${String(spec.type).replace(/_/g, ' ').toLowerCase()})`],
    ['Available', st.availability_mode === 'CUSTOM' ? `${st.start_date} to ${st.end_date}` : 'Always'],
    ['Pickup/delivery window', st.windows.map((w: { day: string; from: string; to: string }) => `${w.day.slice(0, 3)} ${w.from}–${w.to}`).join(', ') || '—'],
    ['Fulfilment', [st.offers_pickup && 'Pickup', st.offers_delivery && 'Delivery'].filter(Boolean).join(' & ') || '—'],
    ['Order by', st.hard_cutoff_date ? `${st.hard_cutoff_date}${st.hard_cutoff_time ? ` ${st.hard_cutoff_time} (local)` : ''}` : `${st.lead_time_hours}h lead time`],
    ['Tip default', st.tip_default_type === 'NONE' ? 'None' : `${st.tip_default_value}${st.tip_default_type === 'PERCENTAGE' ? '%' : ''}`],
    ['Service charge / minimums', `${st.service_charge_pct}% · pickup ${money(st.pickup_order_minimum)} · delivery ${money(st.delivery_order_minimum)}`],
  ]
  return (
    <div style={{ fontSize: 13 }}>
      <table style={{ fontSize: 12, marginBottom: 12, borderCollapse: 'collapse' }}><tbody>
        {rows.map(([k, v]) => <tr key={k}><td style={{ color: MUTED, padding: '2px 12px 2px 0', whiteSpace: 'nowrap' }}>{k}</td><td>{v}</td></tr>)}
      </tbody></table>
      {spec.categories.map((c, ci) => (
        <div key={ci} style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 14, borderBottom: `2px solid ${GOLD}`, paddingBottom: 3 }}>{c.name}</div>
          {c.description && <div style={{ color: MUTED, fontSize: 12, margin: '3px 0' }}>{c.description}</div>}
          {c.items.map((it, ii) => (
            <div key={ii} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: `1px solid ${BORDER}` }}>
              {it.image ? <img src={it.image} alt="" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                : <div style={{ width: 54, height: 54, borderRadius: 6, background: '#F0EFF6', flexShrink: 0, fontSize: 9, color: MUTED, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>no photo</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <b>{it.name}</b>
                  <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{it.display_price || money(it.price)}</span>
                </div>
                {(it.serves || it.min_quantity) && <div style={{ fontSize: 11, color: MUTED }}>{it.serves ? `Serves ${it.serves}` : ''}{it.serves && it.min_quantity ? ' · ' : ''}{it.min_quantity ? `Min ${it.min_quantity}` : ''}</div>}
                {it.description && <div style={{ fontSize: 12, color: '#444' }}>{it.description}</div>}
                {it.option_groups.map((g, gi) => (
                  <div key={gi} style={{ fontSize: 11, marginTop: 3 }}>
                    <b>{g.title}</b>{g.subtitle ? ` (${g.subtitle})` : ''} · {g.min >= 1 ? 'required' : 'optional'}, pick {g.min === g.max ? g.max : `${g.min}–${g.max}`}: {g.options.map(o => `${o.name} ${money(o.price)}`).join(' · ')}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Sessions log ────────────────────────────────────────────────────────────
function Sessions({ onDenied, onOpen }: { onDenied: (m: string) => void; onOpen: (ref: string) => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- session list rows
  const [rows, setRows] = useState<Record<string, any>[] | null>(null)
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api<{ sessions: Record<string, any>[] }>('/api/admin/menu-builder/sessions').then(r => {
      if (r.status === 403 || r.status === 401) return onDenied(r.data.error || 'Not authorized')
      setRows(r.data.sessions || [])
    })
  }, [onDenied])
  if (!rows) return <div style={card}>Loading…</div>
  const total = rows.reduce((a, r) => a + Number(r.cost_usd || 0), 0)
  return (
    <div style={{ ...card, overflowX: 'auto' }}>
      <div style={{ fontSize: 13, marginBottom: 10 }}>{rows.length} session{rows.length === 1 ? '' : 's'} · total API cost <b>{cost(total)}</b></div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead><tr>{['When', 'Who', 'What', 'Locations', 'Status', 'Cost'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px', borderBottom: `1px solid ${BORDER}`, color: MUTED }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.reference} onClick={() => onOpen(r.reference)} style={{ cursor: 'pointer' }}>
            <td style={td}>{new Date(r.created_at).toLocaleString()}</td>
            <td style={td}>{r.actor_email}</td>
            <td style={td}>{r.mode === 'new' ? 'New menu' : `Update “${r.target_menu_name}”`}</td>
            <td style={td}>{(r.restaurant_names || []).join(', ')}</td>
            <td style={td}>{r.status}</td>
            <td style={td}>{cost(r.cost_usd)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// ── Builder Rules ───────────────────────────────────────────────────────────
type RuleRow = { id: number; rules: string; note: string | null; edited_by: string; edited_at: string }
function Rules({ onDenied }: { onDenied: (m: string) => void }) {
  const [cur, setCur] = useState<RuleRow | null>(null)
  const [hist, setHist] = useState<RuleRow[]>([])
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const load = useCallback(async () => {
    const r = await api<{ current: RuleRow; history: RuleRow[] }>('/api/admin/menu-builder/rules')
    if (r.status === 403 || r.status === 401) return onDenied(r.data.error || 'Not authorized')
    setCur(r.data.current); setHist(r.data.history || []); setText(r.data.current?.rules || '')
  }, [onDenied])
  useEffect(() => { load() }, [load])
  async function save() {
    setMsg(null)
    const r = await api<{ current: RuleRow; unchanged?: boolean }>('/api/admin/menu-builder/rules', { method: 'PUT', body: JSON.stringify({ rules: text, note }) })
    if (!r.ok) return setMsg(r.data.error || 'Save failed')
    setMsg(r.data.unchanged ? 'No change.' : 'Saved. Every new turn uses these rules.'); setNote(''); load()
  }
  if (!cur) return <div style={card}>Loading…</div>
  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 900 }}>
      <div style={card}>
        <Label>Builder Rules — the builder always follows these</Label>
        <textarea style={{ ...input, minHeight: 380, fontSize: 12.5, lineHeight: 1.5 }} value={text} onChange={e => setText(e.target.value)} />
        <input style={{ ...input, marginTop: 8 }} placeholder="What changed and why (optional)" value={note} onChange={e => setNote(e.target.value)} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
          <button style={btn()} onClick={save} disabled={text === cur.rules}>Save rules</button>
          {msg && <span style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>
      <div style={card}>
        <Label>History ({hist.length})</Label>
        {hist.map(h => (
          <details key={h.id} style={{ fontSize: 12, marginBottom: 6 }}>
            <summary style={{ cursor: 'pointer' }}>v{h.id} · {new Date(h.edited_at).toLocaleString()} · {h.edited_by}{h.note ? ` — ${h.note}` : ''}</summary>
            <pre style={{ whiteSpace: 'pre-wrap', background: PAGE_BG, padding: 10, borderRadius: 8 }}>{h.rules}</pre>
          </details>
        ))}
      </div>
    </div>
  )
}
