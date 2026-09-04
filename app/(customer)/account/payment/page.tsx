'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

declare global { interface Window { Stripe?: (key: string) => any } }

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'
const INDIGO = '#6466E8'

interface Card {
  id: number
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  isDefault: boolean
}

function Toast({ msg, type = 'success' }: { msg: string; type?: 'success' | 'error' }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: type === 'success' ? '#1D9E75' : '#E24B4A', color: '#fff', padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', fontFamily: F }}>
      {msg}
    </div>
  )
}

function titleCase(s?: string | null) {
  if (!s) return 'Card'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function PaymentPage() {
  const [cards, setCards] = useState<Card[]>([])
  const [loadingCards, setLoadingCards] = useState(true)
  const [stripeKey, setStripeKey] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  // Separate Stripe Elements (number / expiry / CVC) — the unified 'card' Element
  // renders Stripe Link's autofill overlay that covered expiry/CVC.
  const numberRef = useRef<HTMLDivElement>(null)
  const expiryRef = useRef<HTMLDivElement>(null)
  const cvcRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const numberElRef = useRef<any>(null)
  const expiryElRef = useRef<any>(null)
  const cvcElRef = useRef<any>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const loadCards = useCallback(async () => {
    setLoadingCards(true)
    try {
      const res = await fetch('/api/customer-payment-methods', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        setCards(Array.isArray(d.cards) ? d.cards : [])
      }
    } catch { /* empty state */ } finally {
      setLoadingCards(false)
    }
  }, [])

  useEffect(() => {
    loadCards()
    const envKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    if (envKey) {
      setStripeKey(envKey)
    } else {
      fetch('/api/order/stripe-info', { credentials: 'include' })
        .then(r => r.json())
        .then(d => setStripeKey(d.publishableKey || d.publicKey || ''))
        .catch(() => {})
    }
  }, [loadCards])

  // Show the add-card form automatically when there are no saved cards.
  const formVisible = showForm || (!loadingCards && cards.length === 0)

  useEffect(() => {
    if (!formVisible || !stripeKey || !numberRef.current) return
    const mount = () => {
      if (!window.Stripe || numberElRef.current) return
      if (!numberRef.current || !expiryRef.current || !cvcRef.current) return
      stripeRef.current = window.Stripe(stripeKey)
      const elements = stripeRef.current.elements()
      const style = { base: { fontFamily: F, fontSize: '15px', color: DARK, '::placeholder': { color: '#727272' } } }
      numberElRef.current = elements.create('cardNumber', { style, showIcon: false, disableLink: true })
      expiryElRef.current = elements.create('cardExpiry', { style })
      cvcElRef.current = elements.create('cardCvc', { style })
      numberElRef.current.mount(numberRef.current)
      expiryElRef.current.mount(expiryRef.current)
      cvcElRef.current.mount(cvcRef.current)
    }
    if (window.Stripe) { mount() }
    else if (!document.getElementById('stripe-js')) {
      const s = document.createElement('script')
      s.id = 'stripe-js'; s.src = 'https://js.stripe.com/v3/'; s.onload = mount
      document.head.appendChild(s)
    } else {
      const t = setInterval(() => { if (window.Stripe) { clearInterval(t); mount() } }, 50)
      setTimeout(() => clearInterval(t), 3000)
    }
    return () => {
      for (const r of [numberElRef, expiryElRef, cvcElRef]) {
        if (r.current) { r.current.destroy(); r.current = null }
      }
    }
  }, [formVisible, stripeKey])

  async function saveCard(e: React.FormEvent) {
    e.preventDefault()
    if (!stripeRef.current || !numberElRef.current) { showToast('Payment form not ready', 'error'); return }
    setSaving(true)
    try {
      // createPaymentMethod (vs createToken) yields a reusable pm_* we can attach
      // to a Stripe customer in the vault. The linked expiry/CVC Elements are
      // collected automatically since they share the same elements() instance.
      const result = await stripeRef.current.createPaymentMethod({ type: 'card', card: numberElRef.current })
      if (result.error) throw new Error(result.error.message)
      const res = await fetch('/api/customer-payment-methods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: result.paymentMethod.id }),
        credentials: 'include',
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.error || 'Failed to save card')
      }
      showToast('Card saved successfully')
      setShowForm(false)
      await loadCards()
    } catch (err: any) {
      showToast(err.message || 'Failed to save card', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function setDefault(id: number) {
    setCards(prev => prev.map(c => ({ ...c, isDefault: c.id === id })))
    try {
      const res = await fetch(`/api/customer-payment-methods/${id}/default`, { method: 'PATCH', credentials: 'include' })
      if (!res.ok) throw new Error()
      showToast('Default card updated')
    } catch {
      showToast('Could not update default', 'error')
      loadCards()
    }
  }

  async function deleteCard(id: number) {
    try {
      const res = await fetch(`/api/customer-payment-methods/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error()
      showToast('Card removed')
      await loadCards()
    } catch {
      showToast('Could not remove card', 'error')
    }
  }

  return (
    <>
      <div style={{ maxWidth: 480, fontFamily: F }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 8, marginTop: 0 }}>Payment</h1>
        <p style={{ fontSize: 13, color: '#727272', margin: '0 0 24px', lineHeight: 1.5 }}>
          Save cards and choose a default — it&apos;ll be pre-selected at checkout.
        </p>

        {loadingCards ? (
          <div style={{ color: '#727272', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
              {cards.map(c => (
                <div key={c.id} style={{ border: `1.5px solid ${c.isDefault ? INDIGO : '#ebebeb'}`, borderRadius: 12, padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: c.isDefault ? 'rgba(107,110,249,0.04)' : '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                    <span style={{ fontSize: 26 }}>💳</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>
                        {titleCase(c.brand)} ···· {c.last4 || '••••'}
                        {c.isDefault && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: INDIGO, background: 'rgba(107,110,249,0.12)', padding: '2px 8px', borderRadius: 999 }}>Default</span>}
                      </div>
                      {c.expMonth && (
                        <div style={{ fontSize: 12, color: '#727272', marginTop: 2 }}>Expires {c.expMonth}/{String(c.expYear || '').slice(-2)}</div>
                      )}
                      <div style={{ marginTop: 8, display: 'flex', gap: 14 }}>
                        {!c.isDefault && (
                          <button onClick={() => setDefault(c.id)} style={{ background: 'none', border: 'none', color: INDIGO, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: F }}>Set as default</button>
                        )}
                        <button onClick={() => deleteCard(c.id)} style={{ background: 'none', border: 'none', color: '#C0392B', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: F }}>Delete</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {formVisible ? (
              <form onSubmit={saveCard}>
                <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 12, padding: '14px 16px', marginBottom: 14, background: '#fff' }}>
                  <div style={{ fontSize: 11, color: '#727272', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>New card details</div>
                  {stripeKey ? (
                    <>
                      <div style={{ fontSize: 11, color: '#727272', marginBottom: 4 }}>Card number</div>
                      <div ref={numberRef} style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '11px 12px', marginBottom: 10, minHeight: 20 }} />
                      <div style={{ display: 'flex', gap: 10 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: '#727272', marginBottom: 4 }}>Expiry</div>
                          <div ref={expiryRef} style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '11px 12px', minHeight: 20 }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: '#727272', marginBottom: 4 }}>CVC</div>
                          <div ref={cvcRef} style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '11px 12px', minHeight: 20 }} />
                        </div>
                      </div>
                    </>
                  ) : <div style={{ fontSize: 13, color: '#727272' }}>Loading payment form…</div>}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="submit" disabled={saving} style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}>
                    {saving ? 'Saving…' : 'Save card'}
                  </button>
                  {cards.length > 0 && (
                    <button type="button" onClick={() => setShowForm(false)} style={{ background: 'transparent', border: '1px solid #e0e0e0', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <button onClick={() => setShowForm(true)} style={{ background: 'none', color: INDIGO, border: `1.5px dashed ${INDIGO}`, borderRadius: 10, padding: '11px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, width: '100%' }}>
                + Add new card
              </button>
            )}
          </>
        )}
      </div>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </>
  )
}
