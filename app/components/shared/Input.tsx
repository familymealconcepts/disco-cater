'use client'
import React from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6466E8'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

const baseInput: React.CSSProperties = {
  width: '100%',
  padding: '10px 13px',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: F,
  color: DARK,
  outline: 'none',
  boxSizing: 'border-box',
  background: '#fff',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#555',
  display: 'block',
  marginBottom: 6,
  fontFamily: F,
}

export function Input({ label, error, style, ...props }: InputProps) {
  return (
    <div>
      {label && <label style={labelStyle}>{label}</label>}
      <input
        style={{ ...baseInput, ...(error ? { borderColor: '#E24B4A' } : {}), ...style }}
        {...props}
      />
      {error && <div style={{ fontSize: 11, color: '#E24B4A', marginTop: 4, fontFamily: F }}>{error}</div>}
    </div>
  )
}

export function Textarea({ label, error, style, ...props }: TextAreaProps) {
  return (
    <div>
      {label && <label style={labelStyle}>{label}</label>}
      <textarea
        style={{ ...baseInput, resize: 'vertical', ...(error ? { borderColor: '#E24B4A' } : {}), ...style }}
        {...props}
      />
      {error && <div style={{ fontSize: 11, color: '#E24B4A', marginTop: 4, fontFamily: F }}>{error}</div>}
    </div>
  )
}

export { labelStyle as labelSt, baseInput as inputSt }
