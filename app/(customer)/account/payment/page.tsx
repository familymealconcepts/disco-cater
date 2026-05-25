'use client'
import { useState, useEffect, useRef } from 'react'

declare global { interface Window { Stripe?: (key: string) => any } }

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'

function Toast({ msg, type = 'success' }: { msg: string; type?: 'success' | 'error' }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: type === 'success' ? '#1D9E75' : '#E24B4A', color: '#fff', padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', fontFamily: F }}>
      {msg}
    </div>
  )
}

export default function PaymentPage() {
  const [card, setCard] = useState<any>(null)
  const [loadingCard, setLoadingCard] = useState(true)
  const [stripeKey, setStripeKey] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const cardElRef = useRef<any>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    fetch('/api/fm-payment-source', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && (d.brand || d.last4 || d.cardBrand || d.lastFour)) setCard(d) })
      .catch(() => {})
      .finally(() => setLoadingCard(false))

    const envKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    if (envKey) {
      setStripeKey(envKey)
    } else {
      fetch('/api/order/stripe-info', { credentials: 'include' })
        .then(r => r.json())
        .then(d => setStripeKey(d.publishableKey || d.publicKey || ''))
        .catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!showNew || !stripeKey || !cardRef.current) return
    const mount = () => {
      if (!window.Stripe || !cardRef.current || cardElRef.current) return
      stripeRef.current = window.Stripe(stripeKey)
      const elements = stripeRef.current.elements()
      cardElRef.current = elements.create('card', {
        style: { base: { fontFamily: F, fontSize: '15px', color: DARK, '::placeholder': { color: '#bbb' } } },
      })
      cardElRef.current.mount(cardRef.current)
    }
    if (window.Stripe) { mount() }
    else if (!document.getElementById('stripe-js')) {
      const s = document.createElement('script')
      s.id = 'stripe-js'; s.src = 'https://js.stripe.com/v3/'; s.onload = mount
      document.head.appendChild(s)
    }
    return () => { if (cardElRef.current) { cardElRef.current.destroy(); cardElRef.current = null } }
  }, [showNew, stripeKey])

  async function saveCard(e: React.FormEvent) {
    e.preventDefault()
    if (!stripeRef.current || !cardElRef.current) { showToast('Payment form not ready', 'error'); return }
    setSaving(true)
    try {
      const result = await stripeRef.current.createToken(cardElRef.current)
      if (result.error) throw new Error(result.error.message)
      const res = await fetch('/api/fm-payment-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: result.token.id }),
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to save card')
      showToast('Card saved successfully')
      setShowNew(false)
      setCard(null)
      fetch('/api/fm-payment-source', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && (d.brand || d.last4 || d.cardBrand || d.lastFour)) setCard(d) })
        .catch(() => {})
    } catch (err: any) {
      showToast(err.message || 'Failed to save card', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div style={{ maxWidth: 480, fontFamily: F }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 24, marginTop: 0 }}>Payment</h1>

        {loadingCard ? (
          <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
        ) : card ? (
          <div style={{ border: '1.5px solid #ebebeb', borderRadius: 12, padding: '16px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 26 }}>💳</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{card.brand || card.cardBrand || 'Card'} ···· {card.last4 || card.lastFour}</div>
                {(card.expMonth || card.exp_month) && (
                  <div style={{ fontSize: 12, color: '#888' }}>Expires {card.expMonth || card.exp_month}/{String(card.expYear || card.exp_year || '').slice(-2)}</div>
                )}
              </div>
            </div>
            <button onClick={() => setShowNew(true)} style={{ fontSize: 12, color: BLUE, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontFamily: F }}>
              Update
            </button>
          </div>
        ) : (
          <div style={{ border: '1.5px solid #ebebeb', borderRadius: 12, padding: '16px 18px', marginBottom: 16, color: '#888', fontSize: 13 }}>
            No payment method on file.
          </div>
        )}

        {(!card || showNew) && (
          <form onSubmit={saveCard}>
            <div style={{ border: '1.5px solid #e0e0e0', borderRadius: 12, padding: '14px 16px', marginBottom: 14, background: '#fff' }}>
              <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Card details</div>
              {stripeKey
                ? <div ref={cardRef} style={{ padding: '8px 2px', minHeight: 20 }} />
                : <div style={{ fontSize: 13, color: '#aaa' }}>Loading payment form…</div>}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" disabled={saving} style={{ background: saving ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}>
                {saving ? 'Saving…' : 'Save card'}
              </button>
              {showNew && (
                <button type="button" onClick={() => setShowNew(false)} style={{ background: 'transparent', border: '1px solid #e0e0e0', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </div>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </>
  )
}
