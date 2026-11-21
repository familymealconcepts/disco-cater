'use client'
// "Pause new orders" (lib/order/order-pause.ts) — one card, used by the restaurant portal's Settings
// page and by Super Admin → Manage Restaurants → Edit. Saves on its own button, independently of the
// surrounding form, through the URL the host passes.
import { useEffect, useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

interface MenuRow { reference: string; name: string; visible: boolean; archived: boolean }
interface PauseData { pausedUntil: string | null; excludedMenus: string[]; active: boolean; message: string; menus?: MenuRow[] }

/** YYYY-MM-DD for a Date, local time. */
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const label = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

export default function OrderPauseSettings(props: {
  /** GET → PauseData (with menus). */
  loadUrl: string
  /** PUT body { pausedUntil, excludedMenus, ...extraBody }. */
  saveUrl: string
  extraBody?: Record<string, unknown>
  compact?: boolean
}) {
  const [data, setData] = useState<PauseData | null>(null)
  const [on, setOn] = useState(false)
  const [until, setUntil] = useState('')
  const [excluded, setExcluded] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const apply = (d: PauseData) => {
    setData(d); setOn(!!d.active); setUntil(d.active && d.pausedUntil ? d.pausedUntil : ''); setExcluded(d.active ? d.excludedMenus || [] : [])
  }
  useEffect(() => {
    let live = true
    setData(null); setMsg(null)
    fetch(props.loadUrl).then(r => r.json()).then(d => { if (live && !d.error) apply(d) }).catch(() => {})
    return () => { live = false }
  }, [props.loadUrl])

  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return isoOf(d) })()

  async function save() {
    if (on && !until) { setMsg({ ok: false, text: 'Choose the date ordering resumes.' }); return }
    setSaving(true); setMsg(null)
    try {
      const res = await fetch(props.saveUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(props.extraBody || {}), pausedUntil: on ? until : null, excludedMenus: on ? excluded : [] }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: d.error || 'Could not save.' }); return }
      apply({ ...d, menus: data?.menus })
      setMsg({ ok: true, text: d.active ? `Paused. Customers see: “${d.message}”` : 'Taking new orders.' })
    } catch { setMsg({ ok: false, text: 'Could not save.' }) }
    finally { setSaving(false) }
  }

  const menus = data?.menus || []
  const box: React.CSSProperties = props.compact ? {} : { background: '#fff', border: '1px solid #ececf2', borderRadius: 12, padding: '18px 20px', marginBottom: 14 }
  return (
    <div style={{ ...box, fontFamily: F }} data-testid="order-pause-settings">
      <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 6 }}>Pause new orders</div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>
        Stops every new order — on every menu, the ordering link, direct entry, invoices and recurring orders — until the date you choose. Orders already placed are not affected and are still fulfilled.
      </div>
      {!data ? <div style={{ fontSize: 13, color: '#999' }}>Loading…</div> : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: DARK, cursor: 'pointer' }}>
            <input type="checkbox" checked={on} onChange={e => { setOn(e.target.checked); if (!e.target.checked) setExcluded([]) }} />
            Pause new orders
          </label>
          {on && (
            <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
              <label style={{ fontSize: 13, color: DARK }}>
                Resume taking orders on{' '}
                <input type="date" min={tomorrow} value={until} onChange={e => setUntil(e.target.value)}
                  style={{ marginLeft: 6, padding: '7px 9px', border: '1px solid #ddd', borderRadius: 8, fontFamily: F, fontSize: 13 }} />
              </label>
              {until && (
                <div style={{ fontSize: 12.5, color: '#8A5A00', background: '#FFF4E5', border: '1px solid #FFD8A8', borderRadius: 8, padding: '8px 12px' }}>
                  Customers will see: “Not accepting new orders until {label(until).replace(/, \d{4}$/, '')}.” Ordering reopens automatically on {label(until)}.
                </div>
              )}
              {menus.length > 0 && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 6 }}>Keep these menus open (optional)</div>
                  <div style={{ display: 'grid', gap: 5 }}>
                    {menus.map(m => (
                      <label key={m.reference} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: DARK, cursor: 'pointer' }}>
                        <input type="checkbox" checked={excluded.includes(m.reference)}
                          onChange={e => setExcluded(x => e.target.checked ? [...x, m.reference] : x.filter(r => r !== m.reference))} />
                        {m.name}
                        <span style={{ fontSize: 11, color: '#999' }}>{m.archived ? 'Archived' : m.visible ? 'Active' : 'Inactive'}</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#999', marginTop: 6 }}>A menu kept open still follows its own schedule and cutoff.</div>
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving}
              style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save pause setting'}
            </button>
            {data.active && !msg && <span style={{ fontSize: 12.5, color: '#8A5A00' }}>Currently paused: “{data.message}”</span>}
            {msg && <span style={{ fontSize: 12.5, color: msg.ok ? '#2E7D32' : '#C62828' }}>{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  )
}
