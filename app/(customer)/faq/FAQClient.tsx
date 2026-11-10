'use client'
import GlobalHeader from '../../components/GlobalHeader'
import Link from 'next/link'
import Image from 'next/image'
import { useState } from 'react'

const GRADIENT = 'linear-gradient(90deg, #6466E8 0%, #C044C8 50%, #F0468A 100%)'

import { sections, type FAQItem } from './faq-data'

function AccordionItem({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderBottom: '1px solid #f0f0f0' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 0', background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left', gap: 16,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: '#111', fontFamily: "'DM Sans', sans-serif", lineHeight: 1.4, minWidth: 0, overflowWrap: 'break-word' }}>
          {item.q}
        </span>
        <span style={{
          width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
          background: open ? GRADIENT : '#f0f0f0',
          color: open ? '#fff' : '#727272',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 700, transition: 'all 0.2s',
          lineHeight: 1,
        }}>
          {open ? '−' : '+'}
        </span>
      </button>
      <div className="faq-ans" style={{
          paddingBottom: open ? 20 : 0, paddingRight: 44,
          fontSize: 14, color: '#555', lineHeight: 1.7,
          fontFamily: "'DM Sans', sans-serif",
          maxHeight: open ? '2000px' : '0px',
          overflow: 'hidden', overflowWrap: 'break-word',
          transition: 'max-height 0.2s ease, padding-bottom 0.2s ease',
        }}>
          {item.a}
        </div>
    </div>
  )
}

export default function FAQClient() {
  return (
    <>
      <GlobalHeader />
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'DM Sans', sans-serif; background: #fff; color: #111; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
        .faq-nav-link:hover { color: #6466E8 !important; }
        @media (max-width: 768px) {
          .faq-main { padding: 16px 16px 80px !important; }
          .faq-hero { padding: 32px 16px 16px !important; }
          .faq-cta { padding: 28px 20px !important; }
          .faq-ans { padding-right: 16px !important; }
        }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────────── */}
      

      {/* ── Hero ───────────────────────────────────────────────────── */}
      <div className="faq-hero" style={{ padding: '48px 24px 24px', textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#727272', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}>
          Frequently Asked Questions
        </h1>
      </div>

      {/* ── FAQ content ────────────────────────────────────────────── */}
      <main className="faq-main" style={{ maxWidth: 760, margin: '0 auto', padding: '16px 24px 80px' }}>
        {sections.map((section) => (
          <section
            key={section.title}
            id={section.title.toLowerCase().replace(/\s+/g, '-')}
            style={{ paddingTop: 48 }}
          >
            <div style={{ marginBottom: 8 }}>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: '#727272', fontFamily: "'DM Sans', sans-serif", textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {section.title}
              </h2>
            </div>
            <div style={{ borderTop: '2px solid #f0f0f0', marginBottom: 4 }} />
            {section.items.map((item, ii) => (
              <AccordionItem key={ii} item={item} />
            ))}
          </section>
        ))}

        {/* Bottom CTA */}
        <div className="faq-cta" style={{ marginTop: 64, padding: '36px 32px', borderRadius: 20, background: '#fafafa', border: '1px solid #f0f0f0', textAlign: 'center' }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111', fontFamily: "'DM Sans', sans-serif", marginBottom: 8 }}>
            Still have questions?
          </h3>
          <p style={{ fontSize: 14, color: '#727272', fontFamily: "'DM Sans', sans-serif", marginBottom: 20 }}>
            Our team is happy to help.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="mailto:concierge@discocater.com" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 22px', borderRadius: 24, background: '#586CE1', color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}>
              Email us →
            </a>
            <Link href="/fullmap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 22px', borderRadius: 24, border: '1.5px solid #e0e0e0', background: '#fff', color: '#111', fontSize: 14, fontWeight: 600, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}>
              Browse Restaurants
            </Link>
          </div>
        </div>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer style={{ borderTop: '1px solid #f0f0f0', padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#727272', fontFamily: "'DM Sans', sans-serif" }}>
          <a href="mailto:concierge@discocater.com" style={{ color: '#727272', textDecoration: 'none' }}>Contact</a>
          {' · '}© {new Date().getFullYear()} Disco Cater
        </span>
      </footer>
    </>
  )

    </>
  )
}