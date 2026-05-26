'use client'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

export default function ContentManagementPage() {
  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Content Management</h1>
      <p style={{ fontSize: 13, color: '#888', margin: 0 }}>
        Edit the 8 marketing site sections (hero, 3-column, 4-column, CTAs, FAQs, process, marquee).
      </p>
      <div style={{ marginTop: 24, padding: '24px 28px', background: '#fff', borderRadius: 12, border: '1px solid #eee', color: '#555', fontSize: 13, lineHeight: 1.6 }}>
        FM&apos;s content management editor maps eight DTO layouts to{' '}
        <code style={{ background: '#f3f3f6', padding: '2px 6px', borderRadius: 4 }}>GET/POST /api/admin/content-management</code>{' '}
        with rich-text + image uploads via{' '}
        <code style={{ background: '#f3f3f6', padding: '2px 6px', borderRadius: 4 }}>/public-api/images</code>.
        The full editor will land in a follow-up commit; for now, edits should continue to happen
        directly in the FM admin UI.
      </div>
    </div>
  )
}
