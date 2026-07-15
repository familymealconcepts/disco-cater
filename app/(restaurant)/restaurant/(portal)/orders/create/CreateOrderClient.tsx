'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const DARK = '#1A1028'

type PaymentMethod = 'PAYMENT' | 'INVOICE'

// Step 1 of Create Order — the method modal (mirrors FM's create-order popup).
// It does NOT build the order itself: choosing a method routes the admin into
// the normal 1st-party ordering page with a direct-entry flag, exactly like FM.
//   Payment → /order/{slug}?mode=direct-entry&method=payment
//   Invoice → /order/{slug}?mode=direct-entry&method=invoice
export default function CreateOrderMethodModal({ fmSlug, restaurantName }: { fmSlug: string | null; restaurantName?: string | null }) {
  const router = useRouter()
  const [pendingMethod, setPendingMethod] = useState<PaymentMethod>('PAYMENT')

  function go() {
    if (!fmSlug) return
    const method = pendingMethod === 'INVOICE' ? 'invoice' : 'payment'
    router.push(`/order/${fmSlug}?mode=direct-entry&method=${method}`)
  }

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: 20, marginBottom: 18, maxWidth: 460 }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');`}</style>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Create Order</h1>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 16px' }}>How will this order be paid?</p>

      {/* Which restaurant this order will be created for — so a stale selected
          location is obvious BEFORE submitting (RM4 guard). */}
      <div style={{ ...card, maxWidth: 460, background: 'linear-gradient(90deg,rgba(107,110,249,0.08),rgba(240,70,138,0.05))', border: '1px solid #E4E4F5', padding: '12px 16px', marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Creating an order for</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{restaurantName || 'the selected restaurant'}</div>
        {fmSlug && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>discocater.com/order/{fmSlug}</div>}
        <div style={{ fontSize: 11.5, color: '#8a8a8a', marginTop: 8 }}>Not the right restaurant? <a href="/restaurant/select-location" style={{ color: BLUE, fontWeight: 600, textDecoration: 'none' }}>Switch location</a> before continuing.</div>
      </div>

      {!fmSlug && (
        <div style={{ ...card, background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B', fontSize: 13 }}>
          Couldn’t find this restaurant’s ordering page. Make sure online ordering is enabled, then try again.
        </div>
      )}

      <div style={card}>
        {([['PAYMENT', 'Payment Method', 'Enter the customer’s details and pay by card now.'], ['INVOICE', 'Invoice Method', 'Create an unpaid order and email the customer a payment link. No card required.']] as const).map(([val, title, desc]) => (
          <label key={val} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', cursor: 'pointer', borderBottom: val === 'PAYMENT' ? '1px solid #f3f3f3' : 'none' }}>
            <input type="radio" name="create-method" checked={pendingMethod === val} onChange={() => setPendingMethod(val)} style={{ accentColor: BLUE, width: 16, height: 16, marginTop: 2, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{title}</div>
              <div style={{ fontSize: 12.5, color: '#888', marginTop: 2 }}>{desc}</div>
            </div>
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={() => router.push('/restaurant/orders')} style={{ padding: '10px 18px', background: '#f0f0f0', color: DARK, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Cancel</button>
        <button onClick={go} disabled={!fmSlug} style={{ padding: '10px 22px', background: fmSlug ? BLUE : '#ccc', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: fmSlug ? 'pointer' : 'not-allowed', fontFamily: F }}>Continue →</button>
      </div>
    </div>
  )
}
