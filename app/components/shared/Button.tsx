'use client'
import React from 'react'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  children: React.ReactNode
}

const variants: Record<string, React.CSSProperties> = {
  primary: { background: BLUE, color: '#fff', border: 'none' },
  secondary: { background: 'transparent', color: '#555', border: '1px solid #e0e0e0' },
  ghost: { background: 'transparent', color: '#555', border: 'none' },
  danger: { background: '#E24B4A', color: '#fff', border: 'none' },
}

const sizes: Record<string, React.CSSProperties> = {
  sm: { padding: '6px 14px', fontSize: 12 },
  md: { padding: '10px 20px', fontSize: 13 },
  lg: { padding: '12px 26px', fontSize: 15 },
}

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  style,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading
  return (
    <button
      disabled={isDisabled}
      style={{
        fontFamily: F,
        fontWeight: 700,
        borderRadius: 8,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.6 : 1,
        transition: 'opacity 0.12s',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        ...variants[variant],
        ...sizes[size],
        ...style,
      }}
      {...props}
    >
      {loading ? 'Loading…' : children}
    </button>
  )
}
