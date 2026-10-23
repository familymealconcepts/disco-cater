'use client'

// The one opt-out switch. The rule it feeds, and every loader that reads it, is in
// lib/privacy-choices.ts. When the browser sends Global Privacy Control the switch shows on
// and locked, because GPC opts the visitor out whatever the switch says.

import { useSyncExternalStore } from 'react'
import { gpcEnabled, switchOptedOut, setSwitchOptedOut } from '../../../lib/privacy-choices'

const listeners = new Set<() => void>()
function subscribe(fn: () => void) {
  listeners.add(fn)
  window.addEventListener('storage', fn)
  return () => { listeners.delete(fn); window.removeEventListener('storage', fn) }
}
// 'gpc' | 'on' | 'off' on the client; null during SSR so nothing renders until the browser is read.
const snapshot = () => (gpcEnabled() ? 'gpc' : switchOptedOut() ? 'on' : 'off')
const serverSnapshot = () => null

export default function PrivacyChoicesSwitch() {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const checked = state === 'gpc' || state === 'on'

  return (
    <div style={{ margin: '8px 0 22px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: state === 'gpc' ? 'default' : 'pointer', fontSize: 15, color: '#1A1028', fontWeight: 700 }}>
        <input
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          disabled={state === null || state === 'gpc'}
          onChange={e => { setSwitchOptedOut(e.target.checked); listeners.forEach(fn => fn()) }}
          style={{ width: 20, height: 20, accentColor: '#5B6FE8', margin: 0 }}
        />
        Opt out of advertising and visitor identification
      </label>
      {state === 'gpc' && (
        <p className="warn" style={{ marginTop: 14 }}>
          Your browser is sending a Global Privacy Control signal, so this is already on.
        </p>
      )}
    </div>
  )
}
