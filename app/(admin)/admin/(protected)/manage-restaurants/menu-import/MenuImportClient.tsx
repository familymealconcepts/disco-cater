'use client'
import { useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

const ITEM_TYPES = ['CATERING', 'REGULAR'] as const

interface Pkg {
  _id: string
  name: string
  description: string
  price: number
  serves: number
  itemType: string
}

interface ImportResult { name: string; success: boolean; error?: string }

let _seq = 0
function newId() { return `p${Date.now().toString(36)}_${_seq++}` }

function blankPkg(): Pkg {
  return { _id: newId(), name: '', description: '', price: 0, serves: 10, itemType: 'CATERING' }
}

export default function MenuImportClient() {
  const [step, setStep] = useState<'setup' | 'review' | 'results'>('setup')
  const [restaurantReference, setRestaurantReference] = useState('')
  const [mode, setMode] = useState<'pdf' | 'ezcater'>('pdf')
  const [file, setFile] = useState<File | null>(null)
  const [parsing, setParsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [packages, setPackages] = useState<Pkg[]>([])
  const [results, setResults] = useState<ImportResult[]>([])

  function reset() {
    setStep('setup'); setFile(null); setPackages([]); setResults([]); setError('')
    setParsing(false); setSubmitting(false)
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError('')
    const f = e.target.files?.[0]
    if (!f) { setFile(null); return }
    if (f.type !== 'application/pdf') { setError('Please choose a PDF file.'); e.target.value = ''; return }
    if (f.size > 10 * 1024 * 1024) { setError('PDF is too large (max 10MB).'); e.target.value = ''; return }
    setFile(f)
  }

  async function parseMenu() {
    setError('')
    if (!restaurantReference.trim()) { setError('Restaurant Reference is required.'); return }
    if (!file) { setError('Please upload a PDF menu.'); return }
    setParsing(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('restaurantReference', restaurantReference.trim())
      const res = await fetch('/api/admin/menu-import/parse', { method: 'POST', body: fd })
      const data = await res.json().catch(() => null)
      if (!res.ok) { setError(data?.error || 'Failed to parse the menu.'); return }
      const parsed: Pkg[] = (data?.packages || []).map((p: Omit<Pkg, '_id'>) => ({ ...p, _id: newId() }))
      if (!parsed.length) { setError('No packages were found in this PDF.'); return }
      setPackages(parsed)
      setStep('review')
    } catch {
      setError('Something went wrong while parsing. Please try again.')
    } finally {
      setParsing(false)
    }
  }

  function updatePkg(id: string, patch: Partial<Pkg>) {
    setPackages(prev => prev.map(p => p._id === id ? { ...p, ...patch } : p))
  }
  function removePkg(id: string) {
    setPackages(prev => prev.filter(p => p._id !== id))
  }
  function addPkg() {
    setPackages(prev => [...prev, blankPkg()])
  }

  async function submitImport() {
    setError('')
    const valid = packages.filter(p => p.name.trim())
    if (!valid.length) { setError('Add at least one package with a name before importing.'); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/admin/menu-import/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantReference: restaurantReference.trim(),
          packages: valid.map(({ name, description, price, serves, itemType }) => ({ name, description, price, serves, itemType })),
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) { setError(data?.error || 'Import failed.'); return }
      setResults(data?.results || [])
      setStep('results')
    } catch {
      setError('Something went wrong during import. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const successCount = results.filter(r => r.success).length

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Menu Import</h1>
        <p style={{ fontSize: 13, color: '#888', margin: '4px 0 22px' }}>
          Parse a catering menu with AI, review the results, and create meal packages in FamilyMeal.
        </p>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
          {(['setup', 'review', 'results'] as const).map((s, i) => {
            const active = step === s
            const done = (['setup', 'review', 'results'] as const).indexOf(step) > i
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: active ? DARK : done ? '#2E7D32' : '#bbb' }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: active ? GOLD : done ? '#E8F5E9' : '#eee', color: active ? DARK : done ? '#2E7D32' : '#999', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>{i + 1}</span>
                {s === 'setup' ? 'Setup' : s === 'review' ? 'Review & Edit' : 'Results'}
                {i < 2 && <span style={{ color: '#ddd', marginLeft: 4 }}>—</span>}
              </div>
            )
          })}
        </div>

        {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 13, border: '1px solid #ffd6d6' }}>{error}</div>}

        {/* ── STEP 1: SETUP ── */}
        {step === 'setup' && (
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: 24 }}>
            <label style={lbl}>Restaurant Reference</label>
            <input value={restaurantReference} onChange={e => setRestaurantReference(e.target.value)}
              placeholder="e.g. 3f9a1c2e-…" style={inputSt} />
            <p style={helper}>Find this in the restaurant&apos;s FM admin URL.</p>

            <div style={{ marginTop: 22 }}>
              <label style={lbl}>Import Source</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 6 }}>
                <button type="button" onClick={() => setMode('pdf')}
                  style={modeCard(mode === 'pdf', false)}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>📄 PDF Menu</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Upload a PDF catering menu</div>
                </button>
                <button type="button" disabled aria-disabled
                  style={modeCard(false, true)}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#aaa', display: 'flex', alignItems: 'center', gap: 8 }}>
                    🔗 ezCater URL
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#B07000', background: '#FFF8E1', padding: '1px 7px', borderRadius: 10 }}>Coming Soon</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#bbb', marginTop: 4 }}>Paste an ezCater catering page URL</div>
                </button>
              </div>
            </div>

            {mode === 'pdf' && (
              <div style={{ marginTop: 22 }}>
                <label style={lbl}>Menu PDF</label>
                <input type="file" accept="application/pdf" onChange={onPickFile}
                  style={{ display: 'block', fontSize: 13, fontFamily: F, marginTop: 6 }} />
                <p style={helper}>PDF only, max 10MB.{file ? ` · Selected: ${file.name}` : ''}</p>
              </div>
            )}

            <button onClick={parseMenu} disabled={parsing}
              style={{ ...primaryBtn, marginTop: 24, opacity: parsing ? 0.7 : 1, cursor: parsing ? 'default' : 'pointer' }}>
              {parsing ? 'Parsing menu…' : 'Parse Menu'}
            </button>
          </div>
        )}

        {/* ── STEP 2: REVIEW ── */}
        {step === 'review' && (
          <div>
            <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#92400E', marginBottom: 16 }}>
              ⚠️ Review all packages carefully before importing. This will create new meal packages in FamilyMeal and cannot be automatically undone.
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{packages.length} package{packages.length === 1 ? '' : 's'} ready to import</div>
              <button onClick={() => { setStep('setup'); setError('') }} style={secondaryBtn}>← Back</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {packages.map((p, idx) => (
                <div key={p._id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: 16, position: 'relative' }}>
                  <button onClick={() => removePkg(p._id)} title="Remove package"
                    style={{ position: 'absolute', top: 10, right: 10, width: 26, height: 26, borderRadius: '50%', border: '1px solid #eee', background: '#fff', cursor: 'pointer', color: '#c0392b', fontSize: 15, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                  <div style={{ fontSize: 11, color: '#bbb', fontWeight: 700, marginBottom: 8 }}>#{idx + 1}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 10 }}>
                    <div>
                      <label style={lbl}>Name</label>
                      <input value={p.name} onChange={e => updatePkg(p._id, { name: e.target.value })} style={inputSt} placeholder="Package name" />
                    </div>
                    <div>
                      <label style={lbl}>Price ($)</label>
                      <input type="number" min="0" step="0.01" value={p.price}
                        onChange={e => updatePkg(p._id, { price: parseFloat(e.target.value) || 0 })} style={inputSt} />
                    </div>
                    <div>
                      <label style={lbl}>Serves</label>
                      <input type="number" min="0" step="1" value={p.serves}
                        onChange={e => updatePkg(p._id, { serves: parseInt(e.target.value, 10) || 0 })} style={inputSt} />
                    </div>
                    <div>
                      <label style={lbl}>Item Type</label>
                      <select value={p.itemType} onChange={e => updatePkg(p._id, { itemType: e.target.value })} style={inputSt}>
                        {ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <label style={lbl}>Description</label>
                    <textarea value={p.description} onChange={e => updatePkg(p._id, { description: e.target.value })} rows={2}
                      style={{ ...inputSt, resize: 'vertical', lineHeight: 1.5 }} placeholder="Description" />
                  </div>
                </div>
              ))}
            </div>

            <button onClick={addPkg} style={{ ...secondaryBtn, marginTop: 12, width: '100%', padding: '10px' }}>+ Add Package</button>

            <button onClick={submitImport} disabled={submitting}
              style={{ ...primaryBtn, marginTop: 16, opacity: submitting ? 0.7 : 1, cursor: submitting ? 'default' : 'pointer' }}>
              {submitting ? 'Importing…' : 'Import to FamilyMeal'}
            </button>
          </div>
        )}

        {/* ── STEP 3: RESULTS ── */}
        {step === 'results' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 12 }}>
              {successCount} of {results.length} package{results.length === 1 ? '' : 's'} imported successfully
            </div>
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
              {results.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', borderTop: i === 0 ? 'none' : '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: 15, color: r.success ? '#2E7D32' : '#c0392b', flexShrink: 0, marginTop: 1 }}>{r.success ? '✓' : '✕'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>{r.name}</div>
                    {!r.success && r.error && <div style={{ fontSize: 12, color: '#c0392b', marginTop: 2 }}>{r.error}</div>}
                  </div>
                </div>
              ))}
            </div>
            <button onClick={reset} style={{ ...primaryBtn, marginTop: 20 }}>Import Another Menu</button>
          </div>
        )}

        <style>{`select:focus, input:focus, textarea:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; }`}</style>
      </div>
    </div>
  )
}

function modeCard(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    textAlign: 'left', padding: '14px 16px', borderRadius: 12, fontFamily: F,
    border: `1.5px solid ${active ? BLUE : '#e6e6ee'}`,
    background: active ? '#EEF0FD' : disabled ? '#fafafb' : '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer',
    boxShadow: active ? '0 2px 10px rgba(91,111,232,0.12)' : 'none',
  }
}

const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#777', display: 'block', marginBottom: 6 }
const helper: React.CSSProperties = { fontSize: 11, color: '#aaa', margin: '6px 0 0' }
const inputSt: React.CSSProperties = { width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', boxSizing: 'border-box' }
const primaryBtn: React.CSSProperties = { width: '100%', padding: '12px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F }
const secondaryBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: DARK }
