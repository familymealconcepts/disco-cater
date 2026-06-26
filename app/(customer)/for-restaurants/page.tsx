import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'For Restaurants — Disco Cater',
  description: 'Create an account, log in, or learn how Disco Cater works for restaurants that cater.',
}

const F = "'DM Sans', sans-serif"
const GRADIENT = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const DARK = '#1A1028'

const CARDS: { title: string; subtitle: string; href: string }[] = [
  { title: 'Create an Account', subtitle: 'Join Disco Cater and start taking catering orders online.', href: '/become-a-partner' },
  { title: 'Log In', subtitle: 'Access your restaurant dashboard.', href: '/restaurant/login' },
  { title: 'Learn More', subtitle: 'See how Disco Cater works for restaurants.', href: '/faq' },
]

export default function ForRestaurantsPage() {
  return (
    <div style={{ minHeight: '100svh', background: `radial-gradient(ellipse at 12% 0%, rgba(107,110,249,0.22) 0%, transparent 55%), radial-gradient(ellipse at 88% 8%, rgba(240,70,138,0.16) 0%, transparent 52%), ${DARK}`, fontFamily: F, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 20px 64px' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .fr-card { transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease; }
        .fr-card:hover { transform: translateY(-2px); border-color: rgba(192,68,200,0.6); background: rgba(255,255,255,0.06); }
        @media (max-width: 767px) {
          .fr-heading { font-size: 28px !important; }
        }
      `}</style>

      {/* Wordmark */}
      <Link href="/" style={{ textDecoration: 'none', fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 40 }}>
        <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
        <span style={{ color: '#999' }}> cater</span>
      </Link>

      <div style={{ width: '100%', maxWidth: 520, textAlign: 'center' }}>
        <h1 className="fr-heading" style={{ fontSize: 36, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1.15, margin: '0 0 12px' }}>
          Built for restaurants that cater
        </h1>
        <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6, margin: '0 0 36px' }}>
          Manage catering orders, reach new customers, and grow — all in one place.
        </p>

        {/* Option cards — stack vertically, large tap targets */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {CARDS.map(c => (
            <Link key={c.href} href={c.href} className="fr-card" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
              textDecoration: 'none', textAlign: 'left',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 16, padding: '20px 22px', minHeight: 84,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>{c.title}</div>
                <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.6)', marginTop: 4, lineHeight: 1.5 }}>{c.subtitle}</div>
              </div>
              <span aria-hidden style={{ fontSize: 22, color: '#C044C8', flexShrink: 0, fontWeight: 700 }}>→</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
