'use client'
import { useState, useEffect, useMemo } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const RED = '#E24B4A'

export interface CartItem {
  name: string
  quantity: number
  price?: number
}

interface Props {
  isOpen: boolean
  onClose: () => void
  occurrence: {
    id: string
    scheduledDate: string        // YYYY-MM-DD
    cartSnapshot: CartItem[]
    recurringOrderId: string
  }
  restaurantName: string
  restaurantReference: string
  restaurantSlug: string
}

// UTC-safe parse for a YYYY-MM-DD date (noon avoids any DST edge).
function parseDate(s: string): Date { return new Date(`${s}T12:00:00`) }
function fmtLong(s?: string): string {
  if (!s) return ''
  try { return parseDate(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) }
  catch { return s }
}
function fmtMoney(n: number): string { return `$${n.toFixed(2)}` }

export default function RecurringOrderCartEditor({ isOpen, onClose, occurrence, restaurantName, restaurantReference, restaurantSlug }: Props) {
  const [items, setItems] = useState<CartItem[]>([])
  const [saving, setSaving] = useState<'one' | 'all' | null>(null)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  // Item minimums for this restaurant, keyed by lowercased name. This editor's
  // cart snapshot carries names only (no item reference survives
  // subscriptions/page.tsx), so a name is the only join available — hence the
  // name-keyed endpoint. Empty until loaded, and an absent key means "no minimum",
  // so the stepper behaves exactly as before for unminimum'd items.
  const [minimums, setMinimums] = useState<Record<string, number>>({})

  const minFor = (name: string) => {
    const m = minimums[String(name || '').trim().toLowerCase()]
    return Number.isFinite(m) && m > 1 ? Math.trunc(m) : 1
  }

  useEffect(() => {
    if (!isOpen || !restaurantReference) return
    let cancelled = false
    fetch(`/api/order/item-minimums?restaurantReference=${encodeURIComponent(restaurantReference)}`)
      .then(r => r.ok ? r.json() : { minimums: {} })
      .then(d => { if (!cancelled) setMinimums(d?.minimums || {}) })
      .catch(() => {})   // no minimums loaded → stepper floors at 1, as before
    return () => { cancelled = true }
  }, [isOpen, restaurantReference])

  // Re-seed the editable copy each time the modal opens. Runs AFTER minimums land
  // too (they're in the deps) so a snapshot quantity below a minimum the restaurant
  // has since raised is lifted rather than displayed as an invalid figure the
  // customer can't decrease OR save.
  useEffect(() => {
    if (!isOpen) return
    setItems((occurrence.cartSnapshot || []).map(i => {
      const floor = minFor(i.name)
      return { name: i.name, quantity: Math.max(floor, i.quantity || 1), price: i.price }
    }))
    setSaving(null); setSuccess(''); setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, occurrence, minimums])

  const total = useMemo(() => items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0), [items])
  const hasPrices = useMemo(() => items.some(i => typeof i.price === 'number'), [items])

  // 48-hour save deadline = order date − 2 days.
  const deadlineISO = useMemo(() => {
    const d = parseDate(occurrence.scheduledDate); d.setDate(d.getDate() - 2)
    return d.toISOString().slice(0, 10)
  }, [occurrence.scheduledDate])

  // "Coming up soon" = the order date is within 3 days.
  const soon = useMemo(() => {
    const ms = parseDate(occurrence.scheduledDate).getTime() - Date.now()
    return ms <= 3 * 86_400_000
  }, [occurrence.scheduledDate])

  // ESC closes (unless mid-save).
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, saving])

  if (!isOpen) return null

  function setQty(idx: number, q: number) {
    // Floor at the item's own minimum, not at 1. Removing the item entirely is
    // still available via the × control next to the stepper, so stopping here
    // costs the customer nothing.
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, quantity: Math.max(minFor(it.name), q) } : it))
  }
  function removeItem(idx: number) {
    setItems(prev => prev.filter((_, i) => i !== idx))
  }

  async function save(scope: 'one' | 'all') {
    setSaving(scope); setError(''); setSuccess('')
    const url = scope === 'one'
      ? `/api/recurring-orders/${occurrence.recurringOrderId}/occurrences/${occurrence.id}`
      : `/api/recurring-orders/${occurrence.recurringOrderId}`
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cartSnapshot: items }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSuccess(scope === 'one' ? 'This occurrence updated.' : 'All future orders updated.')
    } catch {
      setError('Could not save changes. Please try again.')
    }
    setSaving(null)
  }

  return (
    <div onClick={() => !saving && onClose()} style={backdrop}>
      <div onClick={e => e.stopPropagation()} className="roce-modal" style={modal}>
        <style>{`
          @media (max-width: 560px) {
            .roce-modal { max-width: 100% !important; width: 100% !important; height: 100% !important; max-height: 100% !important; border-radius: 0 !important; }
          }
        `}</style>

        {/* Header */}
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: DARK }}>Modify order for {fmtLong(occurrence.scheduledDate)}</h2>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4, lineHeight: 1.5 }}>
              Changes must be saved before <strong style={{ color: DARK }}>{fmtLong(deadlineISO)}</strong>. This is your {restaurantName} order.
            </div>
          </div>
          <button onClick={() => !saving && onClose()} aria-label="Close" style={closeBtn}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px' }}>
          {soon && (
            <div style={{ background: '#FFF7E6', border: '1px solid #FFE2A8', color: '#7A5800', borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
              ⚠️ This order is coming up soon. Changes must be saved before {fmtLong(deadlineISO)}.
            </div>
          )}

          {items.length === 0 ? (
            <div style={{ fontSize: 13, color: '#999', padding: '16px 0' }}>No items left. Add items to keep this order, or close to leave it unchanged.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map((it, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #ececec', borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
                    {typeof it.price === 'number' && (
                      <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{fmtMoney(it.price)} each</div>
                    )}
                    {/* Same phrasing the ordering page and the add-on group picker
                        use, so a minimum reads identically wherever it appears. */}
                    {minFor(it.name) > 1 && (
                      <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>Select {minFor(it.name)}+</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => setQty(idx, it.quantity - 1)} disabled={it.quantity <= minFor(it.name)} aria-label="Decrease quantity"
                      style={{ ...qtyBtn, opacity: it.quantity <= minFor(it.name) ? 0.4 : 1, cursor: it.quantity <= minFor(it.name) ? 'not-allowed' : 'pointer' }}>−</button>
                    <span style={{ minWidth: 22, textAlign: 'center', fontSize: 14, fontWeight: 700, color: DARK }}>{it.quantity}</span>
                    <button onClick={() => setQty(idx, it.quantity + 1)} aria-label="Increase quantity" style={qtyBtn}>+</button>
                  </div>
                  <button onClick={() => removeItem(idx)} aria-label="Remove item"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', fontSize: 20, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
                </div>
              ))}
            </div>
          )}

          {/* Add items — opens the restaurant in a new tab. */}
          {restaurantSlug && (
            <a href={`/restaurants/${restaurantSlug}`} target="_blank" rel="noopener noreferrer"
              style={{ display: 'inline-block', marginTop: 14, fontSize: 13, fontWeight: 700, color: BLUE, textDecoration: 'none' }}>
              + Add items
            </a>
          )}

          {/* Running total */}
          {hasPrices && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, paddingTop: 14, borderTop: '1px solid #eee' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>Total</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: DARK }}>{fmtMoney(total)}</span>
            </div>
          )}

          {success && (
            <div style={{ background: '#E1F5EE', color: '#085041', borderRadius: 10, padding: 12, marginTop: 16, fontSize: 13, fontWeight: 600 }}>✓ {success}</div>
          )}
          {error && (
            <div style={{ background: '#fff3f3', color: '#c00', borderRadius: 10, padding: 12, marginTop: 16, fontSize: 13 }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {success ? (
            <button onClick={onClose} style={{ ...pillBtn, background: BLUE, color: '#fff' }}>Done</button>
          ) : (
            <>
              <button onClick={() => save('one')} disabled={saving !== null}
                style={{ ...pillBtn, background: BLUE, color: '#fff', opacity: saving ? 0.6 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving === 'one' ? 'Saving…' : 'Save as one-time change'}
              </button>
              <button onClick={() => save('all')} disabled={saving !== null}
                style={{ ...pillBtn, background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, opacity: saving ? 0.6 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving === 'all' ? 'Saving…' : 'Save & update all future orders'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 810,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: F,
}
const modal: React.CSSProperties = {
  background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '92vh',
  display: 'flex', flexDirection: 'column', boxShadow: '0 12px 48px rgba(0,0,0,0.18)', overflow: 'hidden',
}
const closeBtn: React.CSSProperties = {
  background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%',
  fontSize: 18, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
}
const qtyBtn: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8, border: '1.5px solid #e0e0e0', background: '#fff',
  color: DARK, fontSize: 16, fontWeight: 700, lineHeight: 1, fontFamily: F,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const pillBtn: React.CSSProperties = {
  padding: '11px 20px', border: 'none', borderRadius: 999, fontSize: 14, fontWeight: 700, fontFamily: F, cursor: 'pointer',
}

// restaurantReference is part of the public prop contract but not needed for the
// PATCH calls (those key off the recurring-order + occurrence IDs).
void RED
