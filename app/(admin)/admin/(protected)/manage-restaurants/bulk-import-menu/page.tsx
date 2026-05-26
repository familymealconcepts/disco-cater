'use client'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

export default function BulkImportMenuPage() {
  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Bulk Menu Import</h1>
      <p style={{ fontSize: 13, color: '#888', margin: 0 }}>
        Manage import jobs from the external menuupload service.
      </p>
      <div style={{ marginTop: 24, padding: '24px 28px', background: '#fff', borderRadius: 12, border: '1px solid #eee', color: '#555', fontSize: 13, lineHeight: 1.6 }}>
        <p>
          Bulk imports hit{' '}
          <code style={{ background: '#f3f3f6', padding: '2px 6px', borderRadius: 4 }}>
            https://menuuploadstg.familymeal.com/scraped-locations
          </code>
          {' '}with an{' '}
          <code style={{ background: '#f3f3f6', padding: '2px 6px', borderRadius: 4 }}>x-api-key</code>{' '}
          header. The full job list, retry actions, and base64-encoded location IDs will be wired in
          a follow-up commit once the API key is staged in Vercel env.
        </p>
      </div>
    </div>
  )
}
