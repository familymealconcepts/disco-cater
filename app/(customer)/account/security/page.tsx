const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

export default function SecurityPage() {
  return (
    <div style={{ fontFamily: F }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 24, marginTop: 0 }}>Security</h1>
      <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '40px 24px', textAlign: 'center', background: '#fff' }}>
        <div style={{ fontSize: 36, marginBottom: 14 }}>🔒</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 6 }}>Account security</div>
        <div style={{ fontSize: 13, color: '#aaa' }}>Password and security settings coming soon.</div>
      </div>
    </div>
  )
}
