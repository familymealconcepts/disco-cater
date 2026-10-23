'use client'

// The two switches on /privacy-choices. The rules they feed, and every loader that reads them,
// are in lib/privacy-choices.ts.
//   - PrivacyChoicesSwitch: the advertising and visitor-identification opt-out. When the browser
//     sends Global Privacy Control it shows on and locked, because GPC opts the visitor out
//     whatever the switch says.
//   - ConsentSwitch: optional cookies, the same choice as Accept/Decline in the banner. Under GPC
//     it shows off and locked, because GPC reads as Decline. The GPC note is shown once, under
//     the first switch, since its wording ("already on") describes that one.

import { useSyncExternalStore } from 'react'
import { gpcEnabled, switchOptedOut, setSwitchOptedOut, consentChoice, setConsent, CONSENT_EVENT } from '../../../lib/privacy-choices'

function subscribe(fn: () => void) {
  window.addEventListener(CONSENT_EVENT, fn)
  window.addEventListener('storage', fn)
  return () => { window.removeEventListener(CONSENT_EVENT, fn); window.removeEventListener('storage', fn) }
}
// 'gpc' | 'on' | 'off' on the client; null during SSR so nothing renders until the browser is read.
const optOutSnapshot = () => (gpcEnabled() ? 'gpc' : switchOptedOut() ? 'on' : 'off')
const consentSnapshot = () => (gpcEnabled() ? 'gpc' : consentChoice() === 'accepted' ? 'on' : 'off')
const serverSnapshot = () => null

// Saves the switch in this browser, then tells the server, which records it against a signed-in
// diner's email so NM OS keeps them out of ad audiences (app/api/customer/privacy-choices). Signed
// out, the server records nothing. Best-effort: the browser choice stands either way.
function setOptOut(on: boolean) {
  setSwitchOptedOut(on)
  fetch('/api/customer/privacy-choices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optOut: on }),
  }).catch(() => { /* never break the page */ })
}

type State = 'gpc' | 'on' | 'off' | null

function Switch({ state, checked, label, onChange }: { state: State; checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: state === 'gpc' ? 'default' : 'pointer', fontSize: 15, color: '#1A1028', fontWeight: 700 }}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={state === null || state === 'gpc'}
        onChange={e => onChange(e.target.checked)}
        style={{ width: 20, height: 20, accentColor: '#5B6FE8', margin: 0 }}
      />
      {label}
    </label>
  )
}

export default function PrivacyChoicesSwitch() {
  const state = useSyncExternalStore(subscribe, optOutSnapshot, serverSnapshot)
  return (
    <div style={{ margin: '8px 0 22px' }}>
      <Switch state={state} checked={state === 'gpc' || state === 'on'} label="Opt out of advertising and visitor identification" onChange={setOptOut} />
      {state === 'gpc' && (
        <p className="warn" style={{ marginTop: 14 }}>
          Your browser is sending a Global Privacy Control signal, so this is already on.
        </p>
      )}
    </div>
  )
}

export function ConsentSwitch() {
  const state = useSyncExternalStore(subscribe, consentSnapshot, serverSnapshot)
  return (
    <div style={{ margin: '28px 0 14px' }}>
      <Switch state={state} checked={state === 'on'} label="Allow optional cookies" onChange={on => setConsent(on ? 'accepted' : 'declined')} />
    </div>
  )
}
