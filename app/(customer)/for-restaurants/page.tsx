import Link from 'next/link'
import type { Metadata } from 'next'
import GlobalHeader from '../../components/GlobalHeader'

export const metadata: Metadata = {
  title: 'For Restaurants — Disco Cater',
  description: 'Create an account, log in, or learn how Disco Cater works for restaurants that cater.',
}

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'

// Compact value props — emoji + title + description, no borders/shadows.
const VALUE_PROPS: { emoji: string; title: string; desc: string }[] = [
  { emoji: '🪩', title: 'Lower Commissions', desc: 'Keep more of what you earn. Our rates beat every major competitor.' },
  { emoji: '📦', title: 'Catering-Specific Tools', desc: 'Menus, scheduling, and delivery built for catering.' },
  { emoji: '🤖', title: 'AI-Powered Discovery', desc: 'Get found by corporate and social customers looking for catering.' },
]

// Action cards — white, subtle brand-tinted glow, brand-purple arrow.
const CARDS: { title: string; subtitle: string; href: string }[] = [
  { title: 'Log In', subtitle: 'Access your restaurant dashboard.', href: '/restaurant/login' },
  { title: 'Create an Account', subtitle: 'Join Disco Cater and start taking catering orders online.', href: '/become-a-partner' },
]

// Subtle colored shadow tinted with the brand gradient (blue → pink).
const CARD_GLOW = '0 6px 22px rgba(107,110,249,0.22), 0 2px 10px rgba(240,70,138,0.14)'

export default function ForRestaurantsPage() {
  return (
    <div style={{ minHeight: '100svh', background: '#F9FAFB', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .fr-card { transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease; }
        .fr-card:hover { transform: translateY(-2px); border-color: #586CE1; box-shadow: 0 10px 30px rgba(107,110,249,0.30), 0 4px 14px rgba(240,70,138,0.20); }
        .fr-card:hover .fr-arrow { transform: translateX(3px); }
        .fr-arrow { transition: transform 0.15s ease; }
        /* Value props: row on desktop, stacked on mobile. */
        .fr-valueprops { display: flex; gap: 22px; }
        .fr-footer a { color: #727272; text-decoration: none; transition: color 0.15s; }
        .fr-footer a:hover { color: #6466E8; }
        @media (max-width: 767px) {
          .fr-heading { font-size: 28px !important; }
          .fr-valueprops { flex-direction: column; gap: 18px; }
        }
      `}</style>

      {/* Standard site header (same as every other customer page). */}
      <GlobalHeader />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 20px 64px' }}>
      <div style={{ width: '100%', maxWidth: 620, textAlign: 'center' }}>
        {/* Action cards — pulled to the top; large tap targets, stacked */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, margin: '0 0 40px' }}>
          {CARDS.map(c => (
            <Link key={c.href} href={c.href} className="fr-card" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
              textDecoration: 'none', textAlign: 'left',
              background: '#fff', border: '1px solid #E5E7EB',
              borderRadius: 16, padding: '20px 22px', minHeight: 84,
              boxShadow: CARD_GLOW,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: DARK }}>{c.title}</div>
                <div style={{ fontSize: 13.5, color: '#6B7280', marginTop: 4, lineHeight: 1.5 }}>{c.subtitle}</div>
              </div>
              <span aria-hidden className="fr-arrow" style={{ fontSize: 22, color: BLUE, flexShrink: 0, fontWeight: 700 }}>→</span>
            </Link>
          ))}
        </div>

        <h1 className="fr-heading" style={{ fontSize: 36, fontWeight: 800, color: DARK, letterSpacing: '-0.02em', lineHeight: 1.15, margin: '0 0 12px' }}>
          Predictable, recurring and high-margin orders on your terms
        </h1>
        <p style={{ fontSize: 15, color: '#585786', lineHeight: 1.6, margin: '0 0 36px' }}>
          Manage catering orders, reach new customers, and grow — all in one place.
        </p>

        {/* Value props — compact, no borders/shadows */}
        <div className="fr-valueprops" style={{ margin: '0 0 38px', textAlign: 'left' }}>
          {VALUE_PROPS.map(v => (
            <div key={v.title} style={{ flex: 1, display: 'flex', gap: 11, alignItems: 'flex-start' }}>
              <span aria-hidden style={{ fontSize: 20, lineHeight: 1.3, flexShrink: 0 }}>{v.emoji}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: DARK, lineHeight: 1.35 }}>{v.title}</div>
                <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 3, lineHeight: 1.5 }}>{v.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>

      {/* Standard site footer. */}
      <footer className="fr-footer" style={{ padding: '18px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingBottom: 'max(18px, env(safe-area-inset-bottom))' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24, flexWrap: 'wrap' }}>
          <a href="/privacy" style={{ fontSize: 13 }}>Privacy Policy</a>
          <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
          <a href="/terms" style={{ fontSize: 13 }}>Terms</a>
          <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
          <a href="mailto:concierge@discocater.com" style={{ fontSize: 13 }}>Contact</a>
          <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
          <span style={{ fontSize: 13, color: '#ccc' }}>© 2026 Disco Cater</span>
        </div>
      </footer>
    </div>
  )
}
