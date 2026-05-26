'use client'
import { useState, useEffect } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'
const DESTRUCTIVE = '#F0468A'

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 400, width: '90%', fontFamily: F }}>
        <p style={{ fontSize: 14, color: DARK, margin: '0 0 20px', lineHeight: 1.6 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: DESTRUCTIVE, color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  )
}

export default function BankingPage() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)

  async function loadStatus() {
    setLoading(true)
    try {
      const res = await fetch('/api/restaurant/stripe-status')
      if (res.ok) {
        const d = await res.json()
        setConnected(d.connected === true)
      } else {
        setConnected(false)
      }
    } catch {
      setConnected(false)
    }
    setLoading(false)
  }

  useEffect(() => { loadStatus() }, [])

  async function handleConnect() {
    setActionLoading(true)
    setError('')
    try {
      const res = await fetch('/api/restaurant/stripe/connect', { method: 'POST' })
      if (!res.ok) {
        setError('Failed to initiate Stripe connection. Please try again.')
        setActionLoading(false)
        return
      }
      const d = await res.json()
      if (d.stripeConnectUrl) {
        window.location.href = d.stripeConnectUrl
      } else {
        setError('No redirect URL returned. Please try again.')
        setActionLoading(false)
      }
    } catch {
      setError('Network error. Please try again.')
      setActionLoading(false)
    }
  }

  async function handleDisconnect() {
    setShowConfirm(false)
    setActionLoading(true)
    setError('')
    try {
      const res = await fetch('/api/restaurant/stripe/disconnect', { method: 'DELETE' })
      if (!res.ok) {
        setError('Failed to disconnect Stripe. Please try again.')
      } else {
        await loadStatus()
      }
    } catch {
      setError('Network error. Please try again.')
    }
    setActionLoading(false)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 24px' }}>Banking</h1>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '28px 32px', maxWidth: 500 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 16px' }}>Stripe Connect</h2>

        {loading ? (
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 20 }}>Checking connection status…</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: connected ? '#22C55E' : '#D1D5DB',
              display: 'inline-block', flexShrink: 0,
            }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: connected ? '#15803D' : '#6B7280' }}>
              Stripe ({connected ? 'connected' : 'disconnected'})
            </span>
          </div>
        )}

        {error && (
          <div style={{ background: '#FFF0F0', border: '1px solid #FFCDD2', borderRadius: 8, padding: '8px 12px', marginBottom: 16, fontSize: 13, color: '#C62828' }}>
            {error}
          </div>
        )}

        {!loading && (
          connected ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={actionLoading}
              style={{
                padding: '10px 20px', background: DESTRUCTIVE, color: '#fff', border: 'none',
                borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: actionLoading ? 'default' : 'pointer', fontFamily: F,
                opacity: actionLoading ? 0.7 : 1,
              }}
            >
              {actionLoading ? 'Disconnecting…' : 'Disconnect Stripe'}
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={actionLoading}
              style={{
                padding: '10px 20px', background: BLUE, color: '#fff', border: 'none',
                borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: actionLoading ? 'default' : 'pointer', fontFamily: F,
                opacity: actionLoading ? 0.7 : 1,
              }}
            >
              {actionLoading ? 'Connecting…' : 'Connect with Stripe'}
            </button>
          )
        )}

        {!connected && !loading && (
          <p style={{ fontSize: 12, color: '#888', marginTop: 12, lineHeight: 1.6 }}>
            Connect your Stripe account to enable online ordering and receive payments.
          </p>
        )}
      </div>

      {showConfirm && (
        <ConfirmDialog
          message="Are you sure you want to disconnect Stripe? This will disable online ordering."
          onConfirm={handleDisconnect}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  )
}
