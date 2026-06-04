'use client'

import type { CSSProperties } from 'react'

// Concierge "Talk to a Human" button — opens a pre-filled email to the
// Disco Cater concierge. Shared by the fullmap (inline next to the Disco AI
// launcher) and the customer portal (floating, bottom-right). Style is driven
// entirely by the caller's `style` so each placement can match its context;
// the base look is fixed per spec: white pill, 1.5px #1A1028 border, #1A1028
// text. No pulse animation (that stays unique to the AI button).

const CONCIERGE_MAILTO =
  'mailto:concierge@discocater.com?subject=Catering%20Inquiry%20via%20Disco%20Cater&body=Hi%2C%20I%27d%20like%20to%20speak%20with%20someone%20about%20catering.'

export default function TalkToHumanButton({ style }: { style?: CSSProperties }) {
  return (
    <button
      type="button"
      title="Talk to a Human"
      aria-label="Talk to a Human"
      onClick={() => window.open(CONCIERGE_MAILTO, '_blank')}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        background: '#fff', border: '1.5px solid #1A1028', color: '#1A1028',
        borderRadius: 999, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif",
        fontWeight: 600, whiteSpace: 'nowrap', lineHeight: 1,
        ...style,
      }}
    >
      👤 Talk to a Human
    </button>
  )
}
