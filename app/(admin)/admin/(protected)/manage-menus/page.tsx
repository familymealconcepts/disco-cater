'use client'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

export default function AdminMenusPage() {
  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Menus</h1>
      <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Global menu management.</p>
      <div style={{ marginTop: 24, padding: '24px 28px', background: '#fff', borderRadius: 12, border: '1px solid #eee', color: '#555', fontSize: 13, lineHeight: 1.6 }}>
        FM&apos;s SUPER_ADMIN menus surface is sparse (the upstream component is mostly a stub).
        Global menu management — central menu creation, deployment across locations, version
        history — is on the Project Orca roadmap (3.2) and will follow once the FM backend
        exposes the endpoints.
      </div>
    </div>
  )
}
