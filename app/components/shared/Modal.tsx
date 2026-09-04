'use client'
import { useEffect } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  maxWidth?: number
  children: React.ReactNode
}

export default function Modal({ open, onClose, title, maxWidth = 480, children }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 700 }}
      />
      <div
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%,-50%)',
          background: '#fff', borderRadius: 16, padding: 28,
          width: '100%', maxWidth: maxWidth,
          maxHeight: '85vh', overflowY: 'auto',
          zIndex: 701,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
          fontFamily: F,
        }}
      >
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 14, right: 14, background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%', fontSize: 16, color: '#727272', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          ×
        </button>
        {title && (
          <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 16 }}>{title}</div>
        )}
        {children}
      </div>
    </>
  )
}
