'use client'
import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

type FAQItem = { q: string; a: React.ReactNode }
type FAQSection = { id: string; label: string; items: FAQItem[] }

const sections: FAQSection[] = [
  {
    id: 'about',
    label: 'About Disco',
    items: [
      {
        q: 'What is Disco Cater?',
        a: <>Disco Cater is an invitation-only restaurant catering marketplace. We list restaurants that are genuinely worth ordering from — not every restaurant that applies, and definitely not chains. If you've ever sat through mediocre office catering and thought there had to be a better way, this is it.<br /><br />Ordering runs through <strong>FamilyMeal.com</strong>, our underlying platform — so when you place an order on Disco, you're in good hands on the infrastructure side too.</>,
      },
      {
        q: 'How do you decide which restaurants to list?',
        a: <>Every restaurant on Disco is <strong>invited</strong>. We don't accept open applications. Our team personally vets each partner — the food has to be good enough that we'd order it ourselves. That means independent kitchens with real menus, not national chains with a catering checkbox.<br /><br />If a restaurant is on Disco, it's because someone made a deliberate decision that it should be.</>,
      },
      {
        q: 'Which cities does Disco serve?',
        a: <>We're currently live in <strong>New York, Los Angeles, and New Jersey</strong>, with more markets in progress. Each city has its own curated list — restaurants that belong to that food scene, not a generic national roster.</>,
      },
      {
        q: 'Is Disco free to use?',
        a: <>Free to browse, free to order. You pay for the food. No subscription, no membership fee, no cover charge for eating well.</>,
      },
    ],
  },
  {
    id: 'ordering',
    label: 'Ordering',
    items: [
      {
        q: 'How do I place an order?',
        a: <>Browse the restaurants, find one that fits your event, and click Order. You'll be asked for your event date, guest count, delivery address, and any dietary notes — then your request goes directly to the restaurant. They'll confirm within 24 hours, usually sooner. <strong>Payment is collected on confirmation.</strong></>,
      },
      {
        q: 'How far in advance do I need to order?',
        a: <>Lead time varies by restaurant — most ask for at least <strong>24 to 48 hours</strong>. For larger events or more in-demand restaurants, earlier is always better. A week out is a comfortable position to be in.<br /><br />Last-minute requests are possible but not guaranteed. Check directly with the restaurant if timing is tight.</>,
      },
      {
        q: 'Is there a minimum order size?',
        a: <>Minimums vary by restaurant and are listed on each restaurant's page. Some are based on headcount, others on spend. These are working kitchens taking on a catering commitment, so a minimum exists — but it's there to ensure the restaurant can do the job properly, not to pad the bill.</>,
      },
      {
        q: 'Where do you deliver?',
        a: <>Delivery radius depends on the restaurant. Each kitchen sets its own coverage area based on what they can execute without the food suffering for it. You'll see delivery details on the restaurant's page, or you can ask when you submit your order request.</>,
      },
      {
        q: 'What happens after I place an order?',
        a: <>Your order request goes to the restaurant. They'll confirm availability and details within <strong>24 hours</strong> — usually faster. Once confirmed, payment is collected and you'll receive a confirmation email with everything you need.<br /><br />If there's a problem with your request, the restaurant will reach out directly to sort it.</>,
      },
    ],
  },
  {
    id: 'dietary',
    label: 'Dietary & menus',
    items: [
      {
        q: 'Can you accommodate dietary restrictions?',
        a: <>Yes — but it works at the order stage, not the browse stage. We don't currently filter restaurants by dietary profile. Instead, use the dietary notes field when placing your order to tell the restaurant exactly what you need: vegetarian, vegan, gluten-free, halal, nut-free, and so on.<br /><br />Every restaurant on Disco handles catering regularly and is accustomed to these requests. They'll confirm what they can accommodate when they accept your order.</>,
      },
      {
        q: 'Can I customise the menu?',
        a: <>Most restaurants are happy to work with you on menu choices within their catering range. The order form includes a notes field — use it. If you have specific requests (a particular dish, a substitution, a format change), put it in writing when you order. The restaurant will confirm what's possible.</>,
      },
      {
        q: 'What kinds of events does Disco cater for?',
        a: <>Corporate events and office lunches, team away days, product launches, client dinners, birthday parties, housewarmings, graduations, holiday parties, and private dinners.<br /><br />If you're feeding people who care about what they eat, Disco is the right place to start.</>,
      },
    ],
  },
  {
    id: 'pricing',
    label: 'Pricing & cancellations',
    items: [
      {
        q: 'How does pricing work?',
        a: <>Pricing is set by each restaurant and listed on their page — typically per person, sometimes per package. What you see is what the restaurant charges. <strong>There are no hidden platform fees added on top.</strong> The price you agree to at confirmation is the price you pay.</>,
      },
      {
        q: 'When do I pay?',
        a: <>Payment is collected when the restaurant confirms your order — not when you submit the request. You won't be charged for an order that hasn't been confirmed.</>,
      },
      {
        q: 'What is the cancellation policy?',
        a: <>Cancellation terms vary by restaurant — each partner sets their own policy, which will be made clear at confirmation. As a general rule, the further out you cancel, the better your position.<br /><br />If something changes after you've confirmed, contact the restaurant directly as soon as possible. Questions? Reach us at <a href="mailto:hello@eatdisco.com" style={{ color: '#6B6EF9', textDecoration: 'none' }}>hello@eatdisco.com</a>.</>,
      },
    ],
  },
  {
    id: 'restaurants',
    label: 'For restaurants',
    items: [
      {
        q: 'How does a restaurant get listed on Disco?',
        a: <>Disco is invitation-only, which means we reach out to restaurants we want to list — not the other way around. If you run a restaurant and think you belong on Disco, you can express interest at <a href="https://familymeal.com" target="_blank" rel="noopener" style={{ color: '#6B6EF9', textDecoration: 'none' }}>FamilyMeal.com</a>. We review every inquiry, but the decision to list is always ours.</>,
      },
      {
        q: 'Does it cost anything for a restaurant to be on Disco?',
        a: <><strong>Free to list.</strong> Disco takes a commission only when an order is placed and confirmed. No upfront fees, no monthly subscription, no pay-to-play placement. If we don't generate revenue for you, we don't take any.</>,
      },
      {
        q: 'What kinds of restaurants does Disco list?',
        a: <>Independent restaurants with food worth going out of your way for. Italian trattorias, Japanese counters, Mexican taquerias, modern American kitchens, and everything in between — as long as the food is genuinely good.<br /><br />We don't list chains. We don't list restaurants because they have capacity. We list restaurants because the food deserves to be at your event.</>,
      },
    ],
  },
]

function FAQAccordion({ items }: { items: FAQItem[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div>
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            borderTop: '1px solid #f0f0f0',
            paddingTop: 0,
          }}
        >
          <button
            onClick={() => setOpen(open === i ? null : i)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 24,
              padding: '22px 0',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            <span style={{
              fontSize: 16,
              fontWeight: 500,
              color: open === i ? '#6B6EF9' : '#111',
              lineHeight: 1.4,
              letterSpacing: '-0.2px',
              transition: 'color 0.2s',
              flex: 1,
            }}>
              {item.q}
            </span>
            <span style={{
              fontSize: 20,
              color: open === i ? '#6B6EF9' : '#bbb',
              transform: open === i ? 'rotate(45deg)' : 'none',
              transition: 'transform 0.25s ease, color 0.2s',
              flexShrink: 0,
              lineHeight: 1,
              marginTop: 2,
              fontWeight: 300,
            }}>
              +
            </span>
          </button>
          <div style={{
            overflow: 'hidden',
            maxHeight: open === i ? 600 : 0,
            transition: 'max-height 0.4s ease',
          }}>
            <div style={{
              fontSize: 15,
              color: '#666',
              lineHeight: 1.8,
              paddingBottom: 24,
              maxWidth: 580,
            }}>
              {item.a}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function FAQPage() {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { margin: 0; }
        html { scroll-behavior: smooth; }

        .nav-link { color: #555; text-decoration: none; font-size: 14px; font-weight: 500; transition: color 0.15s; }
        .nav-link:hover { color: #6B6EF9; }

        .sidebar-link {
          display: block;
          font-size: 13px;
          color: #888;
          padding: 6px 0;
          text-decoration: none;
          transition: color 0.15s;
          font-family: 'DM Sans', sans-serif;
        }
        .sidebar-link:hover { color: #6B6EF9; }

        .stat-card {
          padding: 20px 24px;
          border-radius: 14px;
          background: #fafafa;
          border: 1px solid #f0f0f0;
        }

        @media (max-width: 768px) {
          .faq-layout { flex-direction: column !important; }
          .faq-sidebar { display: none !important; }
          .page-header-grid { flex-direction: column !important; gap: 32px !important; }
          .header-stats { flex-direction: column !important; gap: 12px !important; }
        }
      `}</style>

      <div style={{ fontFamily: "'DM Sans', sans-serif", background: '#fff', color: '#111', minHeight: '100vh' }}>

        {/* ── Nav ── */}
        <nav style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 48px', borderBottom: '1px solid #f0f0f0',
          position: 'sticky', top: 0, background: '#fff', zIndex: 50,
        }}>
          <Link href="/">
            <Image
              src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=400w"
              alt="Disco Cater" width={120} height={32}
              style={{ objectFit: 'contain', display: 'block' }}
            />
          </Link>
          <div style={{ display: 'flex', gap: 32 }}>
            <Link href="/fullmap" className="nav-link">Catering Map</Link>
            <Link href="/faq" className="nav-link" style={{ color: '#6B6EF9' }}>FAQ</Link>
          </div>
        </nav>

        {/* ── Page header ── */}
        <div style={{
          padding: '64px 48px 56px',
          borderBottom: '1px solid #f0f0f0',
        }}>
          <div className="page-header-grid" style={{ display: 'flex', gap: 64, alignItems: 'flex-end', maxWidth: 1100, margin: '0 auto' }}>
            {/* Left */}
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase',
                color: '#C044C8', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 9 }}>✦</span> Frequently asked questions
              </div>
              <h1 style={{
                fontSize: 'clamp(38px, 5vw, 60px)',
                fontWeight: 800,
                letterSpacing: '-2px',
                lineHeight: 1.02,
                color: '#111',
              }}>
                Everything you<br />
                need to{' '}
                <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  know.
                </span>
              </h1>
            </div>

            {/* Right */}
            <div style={{ flex: 1, paddingBottom: 4 }}>
              <p style={{ fontSize: 15, color: '#777', lineHeight: 1.75, marginBottom: 32 }}>
                We keep this simple: invitation-only restaurants, ordered online, delivered to your event. Still have questions?{' '}
                <a href="mailto:hello@eatdisco.com" style={{ color: '#6B6EF9', textDecoration: 'none', borderBottom: '1px solid rgba(107,110,249,0.3)' }}>
                  hello@eatdisco.com
                </a>
              </p>
              <div className="header-stats" style={{ display: 'flex', gap: 16, paddingTop: 28, borderTop: '1px solid #f0f0f0' }}>
                {[
                  { n: '30+', l: 'Curated restaurant partners' },
                  { n: '3', l: 'Markets: NYC, LA & NJ' },
                  { n: '24h', l: 'Order confirmation turnaround' },
                ].map(s => (
                  <div key={s.n} className="stat-card" style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 28, fontWeight: 800, letterSpacing: '-1px',
                      background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                      lineHeight: 1, marginBottom: 6,
                    }}>{s.n}</div>
                    <div style={{ fontSize: 12, color: '#888', lineHeight: 1.4 }}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── FAQ body ── */}
        <div className="faq-layout" style={{ display: 'flex', maxWidth: 1100, margin: '0 auto' }}>

          {/* Sidebar */}
          <aside className="faq-sidebar" style={{
            width: 200, minWidth: 200, flexShrink: 0,
            padding: '48px 32px 48px 48px',
            position: 'sticky', top: 65,
            height: 'calc(100vh - 65px)',
            overflowY: 'auto',
            borderRight: '1px solid #f0f0f0',
          }}>
            {sections.map(s => (
              <div key={s.id} style={{ marginBottom: 24 }}>
                <div style={{
                  fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                  color: '#bbb', marginBottom: 8, fontWeight: 600,
                }}>
                  {s.label}
                </div>
                {s.items.map((item, i) => (
                  <a
                    key={i}
                    href={`#${s.id}`}
                    className="sidebar-link"
                  >
                    {item.q.length > 36 ? item.q.slice(0, 34) + '…' : item.q}
                  </a>
                ))}
              </div>
            ))}
          </aside>

          {/* Content */}
          <div style={{ flex: 1, padding: '0 64px 96px 64px', minWidth: 0 }}>
            {sections.map(section => (
              <section key={section.id} id={section.id} style={{ paddingTop: 56, borderBottom: '1px solid #f0f0f0', paddingBottom: 8 }}>
                <div style={{
                  fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
                  color: '#C044C8', display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 32, fontWeight: 600,
                }}>
                  <span style={{ fontSize: 8 }}>✦</span> {section.label}
                </div>
                <FAQAccordion items={section.items} />
              </section>
            ))}
          </div>
        </div>

        {/* ── Contact strip ── */}
        <div style={{
          background: '#1A1028',
          padding: '64px 48px',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 64,
          alignItems: 'center',
        }}>
          <div>
            <h2 style={{
              fontSize: 'clamp(26px, 3vw, 38px)',
              fontWeight: 800,
              letterSpacing: '-1px',
              lineHeight: 1.1,
              color: '#fff',
            }}>
              Still have a question?{' '}
              <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Write to us.
              </span>
            </h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.5)', lineHeight: 1.7 }}>
              We're a small team and we actually read our email. If something isn't answered here, or something went sideways with an order, get in touch.
            </p>
            <a
              href="mailto:hello@eatdisco.com"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                fontSize: 15, fontWeight: 600, color: '#fff',
                textDecoration: 'none', transition: 'color 0.15s',
              }}
              onMouseOver={e => (e.currentTarget.style.color = '#C044C8')}
              onMouseOut={e => (e.currentTarget.style.color = '#fff')}
            >
              hello@eatdisco.com →
            </a>
          </div>
        </div>

        {/* ── Footer ── */}
        <footer style={{
          borderTop: '1px solid #f0f0f0', padding: '28px 48px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 16,
        }}>
          <Link href="/">
            <Image
              src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=200w"
              alt="Disco Cater" width={90} height={24} style={{ objectFit: 'contain' }}
            />
          </Link>
          <div style={{ display: 'flex', gap: 24, fontSize: 12, color: '#bbb' }}>
            <Link href="/fullmap" style={{ color: '#bbb', textDecoration: 'none' }}>Catering Map</Link>
            <Link href="/faq" style={{ color: '#bbb', textDecoration: 'none' }}>FAQ</Link>
            <a href="https://www.familymeal.com" style={{ color: '#bbb', textDecoration: 'none' }}>FamilyMeal</a>
          </div>
          <span style={{ fontSize: 12, color: '#ccc' }}>© 2026 FamilyMeal Concepts</span>
        </footer>

      </div>
    </>
  )
}