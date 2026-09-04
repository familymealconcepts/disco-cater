import type { ReactNode } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

// Shared server-rendered chrome + primitives for the four use-case landing
// pages (corporate / holiday / social / meal-prep). Fully server-rendered for
// SEO/GEO — no 'use client'. The FAQ accordion is a pure-CSS checkbox toggle
// (max-height), so every answer is present in the rendered HTML for crawlers.

const DARK = '#1A1028'

export interface FaqItem { q: string; a: string }

const USE_CASES = [
  { slug: 'corporate-catering', label: 'Corporate Catering' },
  { slug: 'holiday-catering', label: 'Holiday Catering' },
  { slug: 'social-catering', label: 'Social Event Catering' },
  { slug: 'meal-prep', label: 'Meal Prep & Subscriptions' },
]

const CITY_FOOTER = [
  { slug: 'new-york', name: 'New York' },
  { slug: 'new-jersey', name: 'New Jersey' },
  { slug: 'los-angeles', name: 'Los Angeles' },
  { slug: 'chicago', name: 'Chicago' },
]

const CSS = `
.uc { font-family: 'DM Sans', sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 24px 56px; color: #333; }
.uc h1 { font-size: 36px; font-weight: 800; color: #1A1028; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 20px; }
.uc h2 { font-size: 22px; font-weight: 700; color: #1A1028; border-bottom: 1px solid #e8e8e8; padding-bottom: 8px; margin: 44px 0 18px; }
.uc h3 { font-size: 16px; font-weight: 700; color: #1A1028; margin: 0 0 6px; }
.uc p { font-size: 16px; line-height: 1.7; color: #333; margin: 0 0 16px; }
.uc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.uc-card { background: #fff; border: 1px solid #ececec; border-radius: 12px; padding: 24px; }
.uc-card p { font-size: 15px; line-height: 1.6; color: #555; margin: 0; }
.uc-tags { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.uc-tag { background: #fff; border: 1px solid #ececec; border-radius: 10px; padding: 13px 16px; font-size: 14px; font-weight: 600; color: #1A1028; }
.uc-callout { background: linear-gradient(180deg, rgba(107,110,249,0.06), rgba(240,70,138,0.04)); border: 1px solid #ece6fa; border-radius: 12px; padding: 20px 24px; }
.uc-callout p { margin: 0; color: #444; }
.uc-steps { display: grid; gap: 12px; }
.uc-step { display: flex; gap: 14px; align-items: flex-start; }
.uc-step .n { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; background: #586CE1; color: #fff; font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.uc-step .t { font-size: 16px; line-height: 1.6; color: #333; padding-top: 2px; }
.uc-faq-item { border: 1px solid #ececec; border-radius: 12px; margin-bottom: 10px; overflow: hidden; }
.uc-faq-toggle { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
.uc-faq-q { display: flex; justify-content: space-between; align-items: center; gap: 12px; cursor: pointer; padding: 16px 18px; font-weight: 700; color: #1A1028; font-size: 16px; }
.uc-faq-q .sign { color: #586CE1; font-size: 22px; line-height: 1; flex-shrink: 0; transition: transform 0.2s ease; }
.uc-faq-a { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
.uc-faq-a p { padding: 0 18px 16px; margin: 0; color: #444; font-size: 15px; line-height: 1.65; }
.uc-faq-toggle:checked ~ .uc-faq-a { max-height: 600px; }
.uc-faq-toggle:checked ~ .uc-faq-q .sign { transform: rotate(45deg); }
.uc-cta { text-align: center; background: #faf9fe; border: 1px solid #eee; border-radius: 16px; padding: 32px 24px; margin: 44px 0 8px; }
.uc-cta h2 { border: none; margin: 0 0 16px; padding: 0; }
.uc-btn { display: inline-block; background: #586CE1; color: #fff; border-radius: 999px; padding: 12px 26px; font-size: 15px; font-weight: 700; text-decoration: none; }
.uc-also { margin-top: 40px; font-size: 14px; color: #666; }
.uc-also a { color: #586CE1; text-decoration: none; }
.uc-footer { font-family: 'DM Sans', sans-serif; border-top: 1px solid #f0f0f0; padding: 24px 24px 40px; max-width: 900px; margin: 0 auto; }
.uc-footer a { text-decoration: none; }
@media (max-width: 700px) {
  .uc h1 { font-size: 28px; }
  .uc-grid { grid-template-columns: 1fr; }
}
`

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2>{heading}</h2>
      {children}
    </section>
  )
}

export function FeatureGrid({ children }: { children: ReactNode }) {
  return <div className="uc-grid">{children}</div>
}

export function FeatureCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="uc-card">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}

export function TagGrid({ items }: { items: string[] }) {
  return (
    <div className="uc-tags">
      {items.map(t => <div key={t} className="uc-tag">{t}</div>)}
    </div>
  )
}

export function Callout({ children }: { children: ReactNode }) {
  return <div className="uc-callout"><p>{children}</p></div>
}

export function Steps({ steps }: { steps: string[] }) {
  return (
    <div className="uc-steps">
      {steps.map((s, i) => (
        <div key={i} className="uc-step">
          <span className="n">{i + 1}</span>
          <span className="t">{s}</span>
        </div>
      ))}
    </div>
  )
}

function Faq({ slug, items }: { slug: string; items: FaqItem[] }) {
  return (
    <section>
      <h2>Frequently Asked Questions</h2>
      {items.map((it, i) => {
        const id = `faq-${slug}-${i}`
        return (
          <div key={id} className="uc-faq-item">
            <input type="checkbox" id={id} className="uc-faq-toggle" defaultChecked={i === 0} />
            <label htmlFor={id} className="uc-faq-q">{it.q}<span className="sign">+</span></label>
            <div className="uc-faq-a"><p>{it.a}</p></div>
          </div>
        )
      })}
    </section>
  )
}

function AlsoSee({ current }: { current: string }) {
  const others = USE_CASES.filter(u => u.slug !== current)
  return (
    <p className="uc-also">
      <strong style={{ color: DARK }}>Also see:</strong>{' '}
      <Link href="/fullmap">Find catering near you</Link>
      {others.map(u => (
        <span key={u.slug}> · <Link href={`/${u.slug}`}>{u.label}</Link></span>
      ))}
    </p>
  )
}

function Footer() {
  return (
    <footer className="uc-footer">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: '#727272' }}>Browse by City</span>
        {CITY_FOOTER.map((c, i) => (
          <span key={c.slug} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {i > 0 && <span style={{ fontSize: 13, color: '#ddd' }}>·</span>}
            <Link href={`/${c.slug}`} style={{ fontSize: 13, color: '#727272' }}>{c.name}</Link>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <a href="/become-a-partner" style={{ fontSize: 13, color: '#6466E8' }}>For Restaurants</a>
        <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
        <a href="/privacy" style={{ fontSize: 13, color: '#727272' }}>Privacy Policy</a>
        <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
        <a href="/terms" style={{ fontSize: 13, color: '#727272' }}>Terms</a>
        <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
        <a href="mailto:concierge@discocater.com" style={{ fontSize: 13, color: '#727272' }}>Contact</a>
        <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
        <span style={{ fontSize: 13, color: '#ccc' }}>© 2026 Disco Cater</span>
      </div>
    </footer>
  )
}

export function UseCaseShell({
  title, slug, ctaHeading, faq, children,
}: {
  title: string
  slug: string
  ctaHeading: string
  faq: FaqItem[]
  children: ReactNode
}) {
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(it => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  }
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <GlobalHeader />
      <main className="uc">
        <h1>{title}</h1>
        {children}
        <Faq slug={slug} items={faq} />
        <div className="uc-cta">
          <h2>{ctaHeading}</h2>
          <Link href="/fullmap" className="uc-btn">Find Catering →</Link>
        </div>
        <AlsoSee current={slug} />
      </main>
      <Footer />
    </>
  )
}
