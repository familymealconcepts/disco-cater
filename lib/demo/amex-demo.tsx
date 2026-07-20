// ⚠️ TEMPORARY DEMO — Amex cardholder demo for a partner meeting.
// Cosmetic ONLY: no real Amex integration, no card verification, no API.
// Strictly gated to ONE hardcoded test-diner email so it can never show for a
// real customer.
//
// ─── HOW TO FULLY REMOVE AFTER THE MEETING ───────────────────────────────────
//   Fastest kill-switch: set AMEX_DEMO_ENABLED = false below. That single flag
//   turns off the header badge, the portal tab, and the page (which redirects).
//   Full removal: delete this file, delete app/(customer)/account/amex-benefits/,
//   and remove the two small `isAmexDemoUser(...)` insertions in
//   GlobalHeader.tsx and AccountLayoutClient.tsx (both marked "AMEX DEMO").
// ─────────────────────────────────────────────────────────────────────────────

// One-place kill switch. false → nothing renders anywhere.
export const AMEX_DEMO_ENABLED = true

// The ONLY account this demo is visible to (exact, case-insensitive match).
export const AMEX_DEMO_EMAIL = 'peteventi+1@gmail.com'

const AMEX_BLUE = '#006FCF'

// Single gate used by every surface. Hardcoded email — NOT a general flag —
// so there is zero chance of leaking to a real customer.
export function isAmexDemoUser(email?: string | null): boolean {
  if (!AMEX_DEMO_ENABLED) return false
  return typeof email === 'string' && email.trim().toLowerCase() === AMEX_DEMO_EMAIL
}

// Header badge — purely cosmetic pill next to the user avatar.
export function AmexBadge() {
  return (
    <span
      title="Amex Cardholder (demo)"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 11px', borderRadius: 999,
        background: AMEX_BLUE, color: '#fff',
        fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
        fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em',
        boxShadow: '0 1px 3px rgba(0,111,207,0.35)',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" />
      </svg>
      Amex Cardholder
    </span>
  )
}

// Credit-card icon for the portal nav entry.
export function AmexNavIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h4" />
    </svg>
  )
}

// Placeholder perks — generic, plausible, NOT real offers.
const AMEX_BENEFITS: { title: string; body: string }[] = [
  { title: 'Cardholder-exclusive discount', body: 'Save 10% on eligible catering orders when you check out — automatically applied for enrolled cardholders.' },
  { title: 'Priority support', body: 'Skip the queue with a dedicated cardholder concierge line for order changes and event planning.' },
  { title: 'Complimentary delivery upgrade', body: 'Enjoy free upgraded delivery windows on qualifying orders, including tighter arrival times for events.' },
  { title: 'Early access to seasonal menus', body: 'Preview and pre-order limited holiday and seasonal catering menus before they open to everyone.' },
]

// Full page content for the "Amex Benefits" portal tab.
export function AmexBenefitsContent({ firstName }: { firstName?: string }) {
  const DARK = '#1A1028'
  const F = "'DM Sans', sans-serif"
  return (
    <div style={{ fontFamily: F, maxWidth: 820 }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '20px 22px',
          borderRadius: 14, background: `linear-gradient(100deg, ${AMEX_BLUE} 0%, #0a4f9e 100%)`,
          color: '#fff', marginBottom: 24,
        }}
      >
        <div style={{
          width: 44, height: 44, borderRadius: 10, background: 'rgba(255,255,255,0.16)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" />
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 800 }}>Amex Cardholder Benefits</div>
          <div style={{ fontSize: 13, opacity: 0.9, marginTop: 2 }}>
            {firstName ? `Welcome, ${firstName} — your` : 'Your'} exclusive catering perks
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
        {AMEX_BENEFITS.map((b) => (
          <div
            key={b.title}
            style={{
              border: '1px solid #ececf2', borderRadius: 12, padding: '16px 18px',
              background: '#fff',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: AMEX_BLUE, flexShrink: 0 }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{b.title}</div>
            </div>
            <div style={{ fontSize: 13, color: '#666', lineHeight: 1.5 }}>{b.body}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, fontSize: 11, color: '#b0b0b0' }}>
        Demo preview. Benefits shown are illustrative placeholders, not active offers.
      </div>
    </div>
  )
}
