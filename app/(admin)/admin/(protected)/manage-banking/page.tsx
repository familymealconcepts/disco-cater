'use client'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'

export default function BankingPage() {
  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Banking</h1>
      <div style={{ marginTop: 24, padding: '32px 28px', background: '#fff', borderRadius: 12, border: `1.5px dashed ${GOLD}`, color: '#555', fontSize: 14, textAlign: 'center' }}>
        Coming soon — platform Stripe configuration, fee templates, and tax templates.
      </div>
    </div>
  )
}
