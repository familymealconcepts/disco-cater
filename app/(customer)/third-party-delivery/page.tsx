import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

export const metadata = {
  title: 'Third-Party Delivery — Disco Cater',
  description:
    'How third-party delivery works on Disco Cater: local couriers are dispatched automatically when a customer chooses delivery at checkout. The customer pays the delivery fee, and restaurants can subsidize it from Settings.',
  alternates: {
    canonical: 'https://www.discocater.com/third-party-delivery',
  },
}

const sectionStyle: React.CSSProperties = { paddingTop: 40 }
const h2Style: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, color: '#aaa', fontFamily: "'DM Sans', sans-serif",
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
}
const pStyle: React.CSSProperties = {
  fontSize: 15, lineHeight: 1.7, color: '#444', fontFamily: "'DM Sans', sans-serif", margin: '0 0 12px',
}

export default function ThirdPartyDeliveryPage() {
  return (
    <>
      <GlobalHeader />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        body { font-family: 'DM Sans', sans-serif; background: #fff; color: #111; }
        @media (max-width: 768px) {
          .tpd-main { padding: 16px 16px 80px !important; }
          .tpd-hero { padding: 32px 16px 16px !important; }
          .tpd-cta { padding: 28px 20px !important; }
        }
      `}</style>

      {/* ── Hero ───────────────────────────────────────────────────── */}
      <div className="tpd-hero" style={{ padding: '48px 24px 24px', textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#888', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}>
          Third-Party Delivery
        </h1>
      </div>

      {/* ── Content ────────────────────────────────────────────────── */}
      <main className="tpd-main" style={{ maxWidth: 760, margin: '0 auto', padding: '16px 24px 80px' }}>
        <section style={sectionStyle}>
          <h2 style={h2Style}>How it works</h2>
          <div style={{ borderTop: '2px solid #f0f0f0', marginBottom: 16 }} />
          <p style={pStyle}>
            Disco Cater gives your restaurant access to a network of local couriers — no separate delivery
            account, app, or contract required. When a customer chooses delivery at checkout, a courier is
            dispatched automatically to pick up the order from your restaurant and deliver it to the customer.
          </p>
          <p style={pStyle}>
            You keep doing what you do best — preparing great catering — while Disco Cater and its courier
            partners handle getting it to the customer&apos;s door.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={h2Style}>Pricing</h2>
          <div style={{ borderTop: '2px solid #f0f0f0', marginBottom: 16 }} />
          <p style={pStyle}>
            The <strong>customer pays the delivery fee</strong> at checkout — it&apos;s separate from your food
            pricing and never comes out of your payout. The fee is <strong>15% of the order subtotal</strong>.
          </p>
          <p style={pStyle}>
            Want to make delivery more attractive? You can choose to <strong>subsidize all or part of the
            delivery fee</strong> from your restaurant Settings — for example, to offer free delivery over a
            certain order size. It&apos;s entirely optional and fully in your control.
          </p>
        </section>

        {/* CTA */}
        <div className="tpd-cta" style={{ marginTop: 64, padding: '36px 32px', borderRadius: 20, background: '#fafafa', border: '1px solid #f0f0f0', textAlign: 'center' }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111', fontFamily: "'DM Sans', sans-serif", marginBottom: 8 }}>
            Ready to start catering with Disco Cater?
          </h3>
          <p style={{ fontSize: 14, color: '#888', fontFamily: "'DM Sans', sans-serif", marginBottom: 20 }}>
            Signing up is fast and risk free.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/become-a-partner" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 22px', borderRadius: 24, background: '#5B6FE8', color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}>
              Become a partner →
            </Link>
            <a href="mailto:concierge@discocater.com" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 22px', borderRadius: 24, border: '1.5px solid #e0e0e0', background: '#fff', color: '#111', fontSize: 14, fontWeight: 600, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}>
              Email us
            </a>
          </div>
        </div>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer style={{ borderTop: '1px solid #f0f0f0', padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#bbb', fontFamily: "'DM Sans', sans-serif" }}>
          <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', fontWeight: 700 }}>disco</span>
          <span style={{ color: '#bbb' }}> cater</span>
          {' · '}
          <a href="mailto:concierge@discocater.com" style={{ color: '#bbb', textDecoration: 'none' }}>Contact</a>
        </span>
      </footer>
    </>
  )
}
