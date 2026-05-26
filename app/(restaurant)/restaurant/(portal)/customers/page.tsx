'use client'
const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'

export default function CustomersPage() {
  return (
    <div style={{ fontFamily: F, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '48px 56px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', textAlign: 'center', maxWidth: 420 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>👥</div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 10px' }}>Customers</h1>
        <p style={{ fontSize: 14, color: '#888', margin: '0 0 20px', lineHeight: 1.6 }}>View and manage your restaurant's customers here.</p>
        <a href="mailto:support@discocater.com" style={{ color: INDIGO, fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
          Contact support@discocater.com
        </a>
      </div>
    </div>
  )
}
