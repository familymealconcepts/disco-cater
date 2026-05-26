'use client'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'

interface Props {
  onClick: () => void
  loading: boolean
  /** Custom label — defaults to "Generate Report" */
  label?: string
  /** Custom label shown while loading — defaults to "Loading…" */
  loadingLabel?: string
  disabled?: boolean
  style?: React.CSSProperties
}

/**
 * Filled-blue trigger button used on every restaurant-portal page that
 * has a date-range filter. Owns its own keyframe + spinner so each page
 * can drop it in without injecting global CSS.
 */
export default function GenerateReportButton({
  onClick, loading, label = 'Generate Report', loadingLabel = 'Loading…',
  disabled, style,
}: Props) {
  const isDisabled = !!(loading || disabled)
  return (
    <>
      <style>{`@keyframes drb-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
      <button
        type="button"
        onClick={onClick}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        style={{
          background: BLUE, color: '#fff', border: 'none', borderRadius: 8,
          padding: '7px 16px', fontSize: 13, fontWeight: 700, fontFamily: F,
          cursor: isDisabled ? 'wait' : 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 8,
          opacity: isDisabled ? 0.85 : 1,
          transition: 'opacity 0.12s',
          whiteSpace: 'nowrap',
          ...style,
        }}
      >
        {loading && (
          <svg width="14" height="14" viewBox="0 0 24 24" style={{ animation: 'drb-spin 0.85s linear infinite', flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.32)" strokeWidth="3" fill="none" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
        )}
        <span>{loading ? loadingLabel : label}</span>
      </button>
    </>
  )
}
