import type { ReactElement } from 'react'

// Shared 1P / 3P order-source badge.
//
// Order attribution comes from the FM `sourceoforder` field:
//   "DISCO"      → 3P (third-party / marketplace order, lead-gen fee applies)
//   "FAMILYMEAL" → 1P (first-party / restaurant's own direct link)
//
// Used across the restaurant portal and super-admin surfaces so the labeling is
// identical everywhere. Returns an inline <span> badge (or null when there is no
// source value to show).
export function getOrderSourceBadge(sourceOfOrder: string): ReactElement | null {
  const source = (sourceOfOrder || '').trim()
  if (!source) return null

  let label: string
  let background: string
  let title: string
  if (source === 'DISCO') {
    label = '3P'
    background = '#6B6EF9'
    title = 'Third-party (Disco Cater marketplace)'
  } else if (source === 'FAMILYMEAL') {
    label = '1P'
    background = '#1A1028'
    title = 'First-party (direct entry)'
  } else {
    label = source
    background = '#999999'
    title = source
  }

  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        marginLeft: 6,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 7px',
        borderRadius: 4,
        color: '#fff',
        background,
        verticalAlign: 'middle',
      }}
    >
      {label}
    </span>
  )
}
