'use client'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

export default function AdminDashboard() {
  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Dashboard</h1>
      <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Platform overview.</p>

      <div style={{ marginTop: 24, padding: '24px 28px', background: '#fff', borderRadius: 12, border: '1px solid #eee', color: '#888', fontSize: 13 }}>
        Dashboard metrics will appear here once the FM SUPER_ADMIN dashboard endpoints are wired up. The list of pages
        in the sidebar reflects the FM admin module — each will be built in subsequent commits.
      </div>
    </div>
  )
}
