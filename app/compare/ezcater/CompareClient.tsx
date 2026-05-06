'use client'
import Link from 'next/link'
import Image from 'next/image'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'
const BLUE = '#5B6FE8'
const DARK = '#1A1028'

type Row = {
  feature: string
  disco: string
  ez: string
  winner: 'disco' | 'ez' | 'tie'
}

const rows: Row[] = [
  {
    feature: 'Commission fees',
    disco: 'Zero commission to restaurants',
    ez: 'Up to 15% per order — passed on to you',
    winner: 'disco',
  },
  {
    feature: 'Monthly platform fees',
    disco: 'None',
    ez: 'Required for full features',
    winner: 'disco',
  },
  {
    feature: 'Exclusive holiday menus',
    disco: 'Proprietary menus for Thanksgiving, winter holidays & seasonal events — only on Disco Cater',
    ez: 'Not available',
    winner: 'disco',
  },
  {
    feature: 'Social event menus',
    disco: 'Proprietary menus for parties, celebrations & social gatherings — exclusive to the platform',
    ez: 'Not available',
    winner: 'disco',
  },
  {
    feature: 'Recurring office programs',
    disco: 'Core specialty — daily, weekly, or custom schedules with curated meal plans',
    ez: 'Supports one-time orders; not optimized for recurring programs',
    winner: 'disco',
  },
  {
    feature: 'AI-powered discovery',
    disco: 'Disco AI — built on Anthropic\'s Claude. Personalized recommendations by event, headcount & budget',
    ez: 'No AI-powered discovery',
    winner: 'disco',
  },
  {
    feature: 'Restaurant curation',
    disco: 'Every restaurant hand-vetted. Premium curated section for top-tier experiences',
    ez: 'Volume-first. Limited quality filtering',
    winner: 'disco',
  },
  {
    feature: 'Meal prep & subscription catering',
    disco: 'Supported — with dedicated menus',
    ez: 'Limited support',
    winner: 'disco',
  },
  {
    feature: 'Restaurant count',
    disco: '700+ hand-vetted restaurants nationwide',
    ez: 'Large volume, variable quality',
    winner: 'tie',
  },
  {
    feature: 'Enterprise accounts',
    disco: 'Yes — leading enterprise companies',
    ez: 'Yes',
    winner: 'tie',
  },
  {
    feature: 'Concierge support',
    disco: 'Free for all customers — human + AI',
    ez: 'Available on higher-tier plans',
    winner: 'disco',
  },
]

const differentiators = [
  {
    icon: '🚫',
    title: 'Zero commission. Full stop.',
    body: 'ezCater charges restaurants up to 15% per order. That cost doesn\'t disappear — it gets buried in your menu prices. Disco Cater charges restaurants nothing, which means the restaurants that join us are here because they want to be, not because they have to pay to play. You get better quality and honest pricing.',
  },
  {
    icon: '🎄',
    title: 'Menus you can\'t get anywhere else.',
    body: 'Disco Cater\'s proprietary holiday and social event menus are built exclusively for the platform. You can\'t order them directly from the restaurant. You can\'t find them on ezCater. They exist only here — purpose-built for Thanksgiving offices, winter parties, birthday celebrations, and every occasion in between.',
  },
  {
    icon: '🔁',
    title: 'Built for recurring, not one-and-done.',
    body: 'Most catering platforms optimize for the single order. Disco Cater is built around the office manager who needs Tuesday lunch handled every week without thinking about it. Curated meal plans, recurring schedules, team preferences on file — this is our core product, not an afterthought.',
  },
  {
    icon: '🤖',
    title: 'Disco AI knows your event better than a search bar does.',
    body: 'Tell Disco what you\'re planning — the occasion, how many people, what you\'re in the mood for, your budget — and it surfaces the right restaurants with the right packages. No scrolling through hundreds of results. No guessing. It\'s built on Anthropic\'s Claude and it\'s included free for every customer.',
  },
]

export default function CompareClient() {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'DM Sans', sans-serif; background: #fff; color: #111; }
        .compare-nav-link:hover { color: #6B6EF9 !important; }
        .cta-btn:hover { opacity: 0.9; }
        @media (max-width: 640px) {
          .compare-table th, .compare-table td { font-size: 13px !important; padding: 14px 12px !important; }
          .hero-title { font-size: 26px !important; }
          .diff-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'linear-gradient(180deg, rgba(107,110,249,0.08) 0%, rgba(240,70,138,0.04) 100%), #fff',
        borderBottom: '1px solid #f0f0f0',
        padding: '10px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <Link href="/" style={{ textDecoration: 'none', flexShrink: 0 }}>
          <Image
            src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=200w"
            alt="Disco Cater"
            width={100}
            height={26}
            style={{ objectFit: 'contain', display: 'block' }}
          />
        </Link>
        <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Link href="/fullmap" className="compare-nav-link" style={{ fontSize: 13, fontWeight: 600, color: '#555', textDecoration: 'none', padding: '6px 12px', borderRadius: 20, fontFamily: "'DM Sans', sans-serif", transition: 'color 0.15s' }}>
            Catering Map
          </Link>
          <Link href="/faq" className="compare-nav-link" style={{ fontSize: 13, fontWeight: 600, color: '#555', textDecoration: 'none', padding: '6px 12px', borderRadius: 20, fontFamily: "'DM Sans', sans-serif", transition: 'color 0.15s' }}>
            FAQ
          </Link>
        </nav>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────── */}
      <div style={{ padding: '56px 24px 40px', textAlign: 'center', maxWidth: 760, margin: '0 auto' }}>
        <div style={{ display: 'inline-block', fontSize: 12, fontWeight: 700, color: '#C044C8', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 16, fontFamily: "'DM Sans', sans-serif" }}>
          Disco Cater vs. ezCater
        </div>
        <h1
          className="hero-title"
          style={{ fontSize: 36, fontWeight: 700, color: DARK, fontFamily: "'DM Sans', sans-serif", lineHeight: 1.2, marginBottom: 20 }}
        >
          We built a better catering platform.{' '}
          <span style={{ backgroundImage: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
            Here's the proof.
          </span>
        </h1>
        <p style={{ fontSize: 16, color: '#666', lineHeight: 1.7, fontFamily: "'DM Sans', sans-serif", maxWidth: 560, margin: '0 auto 32px' }}>
          ezCater built a big marketplace. We built a better one — with no commission fees,
          menus you can't get anywhere else, and AI that actually helps you decide.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link
            href="/fullmap"
            className="cta-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '12px 24px', borderRadius: 24, background: BLUE, color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif", transition: 'opacity 0.15s' }}
          >
            Browse Restaurants →
          </Link>
          <a
            href="mailto:concierge@discocater.com"
            className="cta-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '12px 24px', borderRadius: 24, border: '1.5px solid #e0e0e0', background: '#fff', color: '#111', fontSize: 14, fontWeight: 600, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif", transition: 'opacity 0.15s' }}
          >
            Talk to concierge
          </a>
        </div>
      </div>

      <main style={{ maxWidth: 900, margin: '0 auto', padding: '0 24px 80px' }}>

        {/* ── Stats bar ──────────────────────────────────────────── */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1,
          background: '#f0f0f0', borderRadius: 16, overflow: 'hidden', marginBottom: 56,
        }}>
          {[
            { stat: '700+', label: 'Hand-vetted restaurants' },
            { stat: '40,000+', label: 'Customers served' },
            { stat: '$0', label: 'Commission fees' },
          ].map(({ stat, label }) => (
            <div key={label} style={{ background: '#fff', padding: '24px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, backgroundImage: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', fontFamily: "'DM Sans', sans-serif" }}>
                {stat}
              </div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4, fontFamily: "'DM Sans', sans-serif" }}>
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* ── Comparison table ───────────────────────────────────── */}
        <h2 style={{ fontSize: 20, fontWeight: 700, color: DARK, fontFamily: "'DM Sans', sans-serif", marginBottom: 20 }}>
          Feature-by-feature comparison
        </h2>
        <div style={{ overflowX: 'auto', borderRadius: 16, border: '1px solid #f0f0f0', marginBottom: 64 }}>
          <table className="compare-table" style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Sans', sans-serif" }}>
            <thead>
              <tr style={{ background: '#fafafa', borderBottom: '2px solid #f0f0f0' }}>
                <th style={{ padding: '16px 20px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: '#888', width: '22%' }}>
                  Feature
                </th>
                <th style={{ padding: '16px 20px', textAlign: 'left', fontSize: 13, fontWeight: 700, width: '39%' }}>
                  <span style={{ backgroundImage: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                    Disco Cater
                  </span>
                </th>
                <th style={{ padding: '16px 20px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: '#aaa', width: '39%' }}>
                  ezCater
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.feature}
                  style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fff' : '#fafafa' }}
                >
                  <td style={{ padding: '16px 20px', fontSize: 13, fontWeight: 600, color: '#555', verticalAlign: 'top' }}>
                    {row.feature}
                  </td>
                  <td style={{ padding: '16px 20px', fontSize: 14, color: '#111', verticalAlign: 'top', lineHeight: 1.5 }}>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      {row.winner === 'disco' && (
                        <span style={{ flexShrink: 0, marginTop: 1, width: 18, height: 18, borderRadius: '50%', background: GRADIENT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: 1 }}>✓</span>
                        </span>
                      )}
                      <span>{row.disco}</span>
                    </span>
                  </td>
                  <td style={{ padding: '16px 20px', fontSize: 14, color: '#999', verticalAlign: 'top', lineHeight: 1.5 }}>
                    {row.ez}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Why we're better — detailed ────────────────────────── */}
        <h2 style={{ fontSize: 20, fontWeight: 700, color: DARK, fontFamily: "'DM Sans', sans-serif", marginBottom: 8 }}>
          The four things that actually matter
        </h2>
        <p style={{ fontSize: 14, color: '#888', fontFamily: "'DM Sans', sans-serif", marginBottom: 32, lineHeight: 1.6 }}>
          Not every feature difference is equal. These four are the ones that change what you pay, what you get, and how easy your life is.
        </p>
        <div
          className="diff-grid"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 64 }}
        >
          {differentiators.map((d) => (
            <div
              key={d.title}
              style={{ padding: '28px 24px', borderRadius: 16, border: '1px solid #f0f0f0', background: '#fff' }}
            >
              <div style={{ fontSize: 28, marginBottom: 12 }}>{d.icon}</div>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: DARK, fontFamily: "'DM Sans', sans-serif", marginBottom: 10, lineHeight: 1.3 }}>
                {d.title}
              </h3>
              <p style={{ fontSize: 14, color: '#666', fontFamily: "'DM Sans', sans-serif", lineHeight: 1.7 }}>
                {d.body}
              </p>
            </div>
          ))}
        </div>

        {/* ── Who uses Disco Cater ────────────────────────────────── */}
        <div style={{ padding: '36px 32px', borderRadius: 20, background: '#fafafa', border: '1px solid #f0f0f0', marginBottom: 64 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, fontFamily: "'DM Sans', sans-serif", marginBottom: 8 }}>
            Trusted by teams at
          </h2>
          <p style={{ fontSize: 14, color: '#888', fontFamily: "'DM Sans', sans-serif", marginBottom: 20, lineHeight: 1.6 }}>
            Enterprise clients including leading enterprise companies use Disco Cater for recurring office catering programs.
            Average order value: $450. Customers served: 40,000+.
          </p>
          <p style={{ fontSize: 13, color: '#aaa', fontFamily: "'DM Sans', sans-serif", lineHeight: 1.6 }}>
            For enterprise account setup and high-volume recurring programs, contact{' '}
            <a href="mailto:concierge@discocater.com" style={{ color: BLUE, textDecoration: 'none', fontWeight: 600 }}>
              concierge@discocater.com
            </a>.
          </p>
        </div>

        {/* ── Bottom CTA ─────────────────────────────────────────── */}
        <div style={{ padding: '40px 32px', borderRadius: 20, background: DARK, textAlign: 'center' }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fff', fontFamily: "'DM Sans', sans-serif", marginBottom: 10 }}>
            Ready to make the switch?
          </h2>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', fontFamily: "'DM Sans', sans-serif", marginBottom: 28, lineHeight: 1.6 }}>
            No commissions. No monthly fees. Menus built for the occasion.{' '}
            Powered by AI that actually helps.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link
              href="/fullmap"
              className="cta-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '12px 28px', borderRadius: 24, background: GRADIENT, color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif", transition: 'opacity 0.15s' }}
            >
              Browse Restaurants →
            </Link>
            <a
              href="mailto:concierge@discocater.com"
              className="cta-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '12px 24px', borderRadius: 24, border: '1.5px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#fff', fontSize: 14, fontWeight: 600, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif", transition: 'opacity 0.15s' }}
            >
              Talk to concierge
            </a>
          </div>
        </div>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer style={{ borderTop: '1px solid #f0f0f0', padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 12, color: '#bbb', fontFamily: "'DM Sans', sans-serif" }}>
          <a href="mailto:info@familymeal.com" style={{ color: '#bbb', textDecoration: 'none' }}>Contact</a>
          {' · '}© {new Date().getFullYear()} FamilyMeal Concepts
        </span>
      </footer>
    </>
  )
}
