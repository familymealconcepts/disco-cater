'use client'
import Link from 'next/link'
import Image from 'next/image'
import { useState } from 'react'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

type FAQItem = { q: string; a: string | React.ReactNode }
type Section = { title: string; items: FAQItem[] }

const sections: Section[] = [
  {
    title: 'About Us',
    items: [
      {
        q: 'What is Disco Cater?',
        a: 'We aim to be the best place to search and order catering online. With a wide variety of restaurant partners, event-specific catering menus and intelligent recommendations, finding the perfect catering option has never been more fun.',
      },
      {
        q: 'Who is Disco Cater for?',
        a: 'Disco is built for anyone who wants an elevated catering experience: offices planning team lunches or company events, event planners, and individuals hosting parties or special occasions.',
      },
      {
        q: 'What makes Disco Cater different from other catering sites?',
        a: 'Three things set us apart: premium restaurant curation (restaurants love us so we get the best ones to join!), special menus built for catering occasions rather than repurposed takeout menus, and a personal concierge who helps you choose, order, and coordinate everything.',
      },
      {
        q: 'Where does Disco Cater operate?',
        a: 'We operate nationwide and are growing rapidly. Be on the lookout for new restaurants in your area popping up soon.',
      },
    ],
  },
  {
    title: 'Ordering',
    items: [
      {
        q: 'How do I place a catering order?',
        a: <>Browse local restaurant partners and click to visit their menu page and place your order online. You can use our AI Disco Bot for more tailored restaurant recommendations or email our team at <a href="mailto:concierge@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>concierge@discocater.com</a> for a more human, concierge support.</>,
      },
      {
        q: 'What types of events can I cater through Disco?',
        a: 'Disco supports office lunches, corporate events, holiday parties, social gatherings, pop-ups, and special occasions. Restaurants offer specialized menus tailored to each format.',
      },
      {
        q: 'How far in advance should I place my order?',
        a: 'Each of our restaurants gets to customize their own ordering settings, including lead times, minimums and availability. Your human or AI concierge can advise on specific event ordering.',
      },
      {
        q: 'How do I manage or change my order?',
        a: <>We encourage you to contact the restaurant directly — their contact information will be included in your order confirmation email. If you are still having issues, email us at <a href="mailto:support@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>support@discocater.com</a>.</>,
      },
    ],
  },
  {
    title: 'Pricing & Fees',
    items: [
      {
        q: 'How does pricing work?',
        a: 'Pricing is based on the menu you select from a partner restaurant. There is a 3.00% convenience fee charged at checkout (that goes to Disco Cater) and the restaurant may choose to include additional fees as well.',
      },
      {
        q: 'Is delivery included?',
        a: 'Delivery is optional and depends on the restaurant and menu you are looking at.',
      },
      {
        q: 'Are there any hidden fees?',
        a: 'No. All applicable fees are shown at checkout before you confirm your order. There are no term commitments or surprise charges.',
      },
    ],
  },
  {
    title: 'Concierge Service',
    items: [
      {
        q: 'What is the personal concierge service?',
        a: <>Every Disco Cater customer has access to a dedicated market concierge who can help you select the right restaurant and menu for your event, answer questions, and ensure your order goes smoothly from placement to delivery. Just contact <a href="mailto:concierge@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>concierge@discocater.com</a> and we will match you with the right person from our team.</>,
      },
      {
        q: 'Is there a cost for concierge service?',
        a: 'No. Personal concierge service and unlimited support are included at no extra charge for all Disco Cater customers.',
      },
    ],
  },
  {
    title: 'For Restaurant Partners',
    items: [
      {
        q: 'Why should I be on Disco Cater?',
        a: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0 }}>There are a number of benefits that separate us from other catering marketplaces:</p>
            {[
              { n: '1', title: 'Complete operator control.', body: 'Own your customer data and get access to all of your platform tools. Menu pricing, lead times, promo codes, delivery options and much more can be customized and controlled by your team.' },
              { n: '2', title: 'Best-in-class delivery.', body: 'Use your own drivers or leverage our delivery integrations for seamless, catering-specific delivery.' },
              { n: '3', title: 'Multi-menu tech.', body: 'We can customize ordering for your distinct office, holiday and event catering menus and advertise them more effectively.' },
              { n: '4', title: 'Pricing.', body: 'Our pricing is typically lower than all of our competitors.' },
              { n: '5', title: 'No risk.', body: 'There is no financial cost to joining Disco Cater, only the cost of your time — something we strive to minimize.' },
            ].map(item => (
              <div key={item.n} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', background: GRADIENT, color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>{item.n}</div>
                <p style={{ margin: 0, fontSize: 14, color: '#555', lineHeight: 1.6 }}><strong style={{ color: '#111' }}>{item.title}</strong> {item.body}</p>
              </div>
            ))}
          </div>
        ),
      },
      {
        q: 'What does it cost to be a Disco Cater restaurant partner?',
        a: "There are no monthly or fixed fees. The marketplace fee is 15% on a customer's first order, and 5% on all recurring orders from that same customer. Additionally, credit card processing (2.90% + $0.30) is paid by the restaurant partner.",
      },
      {
        q: "Do I need to use FamilyMeal as my 1st-party ordering platform?",
        a: "No, but it's the recommended path. If you use FamilyMeal as your native catering platform, order management and payouts are handled seamlessly. Pricing is also reduced for partners using FamilyMeal as their 1st-party ordering platform.",
      },
      {
        q: 'What are the next steps for joining?',
        a: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#555' }}>Create a free account on our catering platform, FamilyMeal:</p>
            <a href="https://www.familymeal.com/become-a-partner" target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 18px', borderRadius: 20, background: '#1A1028', color: '#fff', fontSize: 13, fontWeight: 700, textDecoration: 'none', width: 'fit-content' }}>
              Get started on FamilyMeal →
            </a>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {[
                'Enter your business and contact details',
                'Connect to Stripe for payouts',
                'Upload your catering menu(s)',
                'Approve your menu and ordering settings on a quick call with our team',
                "That's it!",
              ].map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 12, color: '#C044C8', fontWeight: 700, minWidth: 16 }}>{String.fromCharCode(97 + i)}.</span>
                  <span style={{ fontSize: 14, color: '#555', lineHeight: 1.5 }}>{step}</span>
                </div>
              ))}
            </div>
          </div>
        ),
      },
    ],
  },
]

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
        <span style={{ fontSize: 15, fontWeight: 600, color: '#111', fontFamily: "'DM Sans', sans-serif", lineHeight: 1.4 }}>
          {item.q}
        </span>
        <span style={{
          width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
          background: open ? GRADIENT : '#f0f0f0',
          color: open ? '#fff' : '#888',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 700, transition: 'all 0.2s',
          lineHeight: 1,
        }}>
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div style={{
          paddingBottom: 20, paddingRight: 44,
          fontSize: 14, color: '#555', lineHeight: 1.7,
          fontFamily: "'DM Sans', sans-serif",
          animation: 'fadeIn 0.15s ease',
        }}>
          {item.a}
        </div>
      )}
    </div>
  )
}

export default function FAQPage() {
  const [activeSection, setActiveSection] = useState<string | null>(null)

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'DM Sans', sans-serif; background: #fff; color: #111; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
        .faq-nav-link:hover { color: #6B6EF9 !important; }
        .section-pill:hover { background: #f0f0f0 !important; }
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
          <Link href="/fullmap" className="faq-nav-link" style={{ fontSize: 13, fontWeight: 600, color: '#555', textDecoration: 'none', padding: '6px 12px', borderRadius: 20, fontFamily: "'DM Sans', sans-serif", transition: 'color 0.15s' }}>
            Catering Map
          </Link>
          <Link href="/faq" style={{ fontSize: 13, fontWeight: 600, color: '#fff', textDecoration: 'none', padding: '6px 14px', borderRadius: 20, background: GRADIENT, fontFamily: "'DM Sans', sans-serif" }}>
            FAQ
          </Link>
        </nav>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────── */}
      <div style={{ padding: '48px 24px 24px', textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#888', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}>
          Frequently Asked Questions
        </h1>
      </div>

      {/* ── FAQ content ────────────────────────────────────────────── */}
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '16px 24px 80px' }}>
        {sections.map((section, si) => (
          <section
            key={section.title}
            id={section.title.toLowerCase().replace(/\s+/g, '-')}
            style={{ paddingTop: 48 }}
          >
            {/* Section header */}
            <div style={{ marginBottom: 8 }}>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: '#aaa', fontFamily: "'DM Sans', sans-serif", textTransform: 'uppercase', letterSpacing: '0.08em' }}>
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
        <div style={{ marginTop: 64, padding: '36px 32px', borderRadius: 20, background: '#fafafa', border: '1px solid #f0f0f0', textAlign: 'center' }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111', fontFamily: "'DM Sans', sans-serif", marginBottom: 8 }}>
            Still have questions?
          </h3>
          <p style={{ fontSize: 14, color: '#888', fontFamily: "'DM Sans', sans-serif", marginBottom: 20 }}>
            Our team is happy to help.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="mailto:hello@discocater.com" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 22px', borderRadius: 24, background: '#5B6FE8', color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}>
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
        <span style={{ fontSize: 12, color: '#bbb', fontFamily: "'DM Sans', sans-serif" }}>
          <a href="mailto:info@familymeal.com" style={{ color: '#bbb', textDecoration: 'none' }}>Contact</a>
          {' · '}© {new Date().getFullYear()} FamilyMeal Concepts
        </span>
      </footer>
    </>
  )
}