'use client'
import { useState, useCallback } from 'react'

const F = "'DM Sans', sans-serif"

type ToastType = 'success' | 'error' | 'info'

const bg: Record<ToastType, string> = {
  success: '#1D9E75',
  error: '#E24B4A',
  info: '#5B6FE8',
}

interface ToastProps {
  msg: string
  type?: ToastType
}

export function Toast({ msg, type = 'success' }: ToastProps) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: bg[type], color: '#fff', padding: '11px 22px', borderRadius: 10,
      fontSize: 13, fontWeight: 600, zIndex: 900,
      boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
      whiteSpace: 'nowrap', fontFamily: F,
      animation: 'fadeInUp 0.2s ease',
    }}>
      {msg}
    </div>
  )
}

export function useToast(duration = 3000) {
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(null)

  const show = useCallback((msg: string, type: ToastType = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), duration)
  }, [duration])

  return { toast, show }
}
