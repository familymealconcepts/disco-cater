'use client'

const F = "'DM Sans', sans-serif"

interface LoadingSpinnerProps {
  size?: number
  color?: string
  label?: string
  fullPage?: boolean
}

export default function LoadingSpinner({ size = 28, color = '#6B6EF9', label, fullPage }: LoadingSpinnerProps) {
  const spinner = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        style={{ animation: 'spin 0.75s linear infinite' }}
      >
        <circle cx="12" cy="12" r="10" stroke="#e0e0e0" strokeWidth="3" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span style={{ fontSize: 13, color: '#888', fontFamily: F }}>{label}</span>}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (fullPage) {
    return (
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {spinner}
      </div>
    )
  }

  return spinner
}
