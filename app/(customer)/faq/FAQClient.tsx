'use client'
import GlobalHeader from '../../components/GlobalHeader'
import Link from 'next/link'
import Image from 'next/image'
import { useState } from 'react'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

type FAQItem = { q: string; a: string | React.ReactNode }
type Section = { title: string; items: FAQItem[] }

const sections: Section[] = [
  {
    title: 'About Disco Cater',
    items: [
      {
        q: 'What is Disco Cater?',
        a: 'Disco Cater is a nationwide premium restaurant catering marketplace. The platform connects businesses, office managers, and event planners with hand-vetted restaurants for corporate catering, holiday events, social gatherings, and meal prep programs. Unlike general food delivery apps, Disco Cater is built exclusively for catering — with proprietary menus for holidays and special events that are only available through the platform.',
      },
      {
        q: 'How is Disco Cater different from ezCater?',
        a: "Disco Cater differs from ezCater in three fundamental ways. First, the platform is commission-free — restaurants pay zero commission and zero monthly fees, compared to ezCater which charges up to 40% per order. Second, Disco Cater offers proprietary holiday and social event menus exclusive to the marketplace and unavailable anywhere else. Third, Disco Cater features Disco AI, an AI-powered catering assistant built on Claude by Anthropic, for personalized restaurant and menu recommendations.",
      },
      {
        q: 'Who uses Disco Cater?',
        a: 'Disco Cater is used by office managers setting up recurring corporate meal programs, event planners organizing holiday parties and social gatherings, and individuals ordering catering for personal celebrations. Enterprise clients including leading enterprise companies use Disco Cater for recurring office catering. Disco Cater has served 40,000+ customers nationwide with an average order value of $450.',
      },
      {
        q: 'Where does Disco Cater operate?',
        a: 'Disco Cater is available nationwide with 700+ hand-vetted restaurants across the United States. Use the search bar on the homepage to enter your location and see available restaurants and menus near you.',
      },
    ],
  },
  {
    title: 'Corporate & Office Catering',
    items: [
      {
        q: 'Can I set up recurring catering orders for my office?',
        a: (
          <>
            Yes — recurring office catering programs are one of Disco Cater's core specialties. Office managers can use Disco Cater to set up recurring orders on a daily, weekly, or custom schedule, build curated catering plans tailored to their team's preferences, and manage ongoing meal programs all in one place. Disco AI can help find the right restaurants and packages for your team size and budget. For enterprise account setup or high-volume recurring programs, contact{' '}
            <a href="mailto:concierge@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>concierge@discocater.com</a>.
          </>
        ),
      },
      {
        q: 'What types of corporate catering does Disco Cater support?',
        a: 'Disco Cater supports all major corporate catering formats: recurring daily or weekly office lunches, one-time team events and celebrations, holiday office parties, client entertainment meals, and large-scale all-hands or company event catering. The platform handles orders for groups ranging from 10 to 500+ people.',
      },
      {
        q: 'Does Disco Cater have enterprise accounts?',
        a: (
          <>
            Yes. Disco Cater supports enterprise accounts for organizations that need recurring catering programs, centralized billing, and dedicated support. Enterprise clients including leading enterprise companies use Disco Cater for their office catering needs. To set up an enterprise account, contact{' '}
            <a href="mailto:concierge@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>concierge@discocater.com</a>.
          </>
        ),
      },
      {
        q: 'How far in advance should I place a catering order?',
        a: 'For most orders, placing your catering order at least 24–48 hours in advance is recommended. For large orders (100+ people), holiday events, or orders using exclusive proprietary menus, ordering 5–7 days in advance is strongly recommended to ensure availability. Each restaurant customizes their own lead time settings — Disco AI will flag requirements when recommending packages for your event.',
      },
    ],
  },
  {
    title: 'Holiday & Social Event Catering',
    items: [
      {
        q: 'Does Disco Cater have holiday catering menus?',
        a: 'Yes — holiday catering menus are one of Disco Cater\'s signature offerings. Disco Cater features proprietary holiday menus for Thanksgiving, winter holiday parties, seasonal events, and other occasions that are exclusive to the marketplace and not available through any other catering platform or directly from the restaurants. These menus are purpose-built for holiday catering and updated each season.',
      },
      {
        q: 'What kinds of social events can I order catering for?',
        a: 'Disco Cater supports catering for a wide range of social events including birthday parties, graduation celebrations, wedding showers, family gatherings, neighborhood events, and casual get-togethers. The platform features proprietary social event menus exclusive to Disco Cater, designed specifically for celebrations and gatherings outside of a corporate setting.',
      },
      {
        q: 'What makes Disco Cater\'s event menus different from ordering directly from a restaurant?',
        a: 'Disco Cater offers proprietary catering menus for holidays and special events that are created exclusively for the platform — meaning these menus are not available if you order directly from the restaurant or through any other delivery or catering service. These menus are designed specifically for group catering, with appropriate serving sizes, packaging, and pricing for events.',
      },
    ],
  },
  {
    title: 'Ordering',
    items: [
      {
        q: 'How do I place a catering order?',
        a: (
          <>
            Browse restaurant partners on the map at discocater.com/fullmap and click to visit their menu page and place your order online. You can use Disco AI for tailored restaurant recommendations based on your event, or email our concierge team at{' '}
            <a href="mailto:concierge@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>concierge@discocater.com</a> for dedicated human support.
          </>
        ),
      },
      {
        q: 'How do I manage or change my order?',
        a: (
          <>
            We encourage you to contact the restaurant directly — their contact information will be included in your order confirmation email. If you are still having issues, email us at{' '}
            <a href="mailto:concierge@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>concierge@discocater.com</a>.
          </>
        ),
      },
      {
        q: 'Is there a minimum order size?',
        a: 'Minimum order sizes vary by restaurant and package. Most catering packages on Disco Cater are designed for groups of 10 or more people. Some restaurants have minimum order values rather than minimum headcounts. Disco AI will surface packages that match your group size when you describe your event.',
      },
    ],
  },
  {
    title: 'Pricing & Fees',
    items: [
      {
        q: 'How does pricing work?',
        a: 'Pricing is based on the menu you select from a partner restaurant. There is a 3.00% convenience fee charged at checkout (that goes to Disco Cater) and the restaurant may choose to include additional fees as well. All applicable fees are shown at checkout before you confirm your order.',
      },
      {
        q: 'Is delivery included?',
        a: 'Delivery is optional and depends on the restaurant and menu you are looking at. Most restaurants on Disco Cater service a 20-mile delivery radius.',
      },
      {
        q: 'Are there any hidden fees?',
        a: 'No. All applicable fees are shown at checkout before you confirm your order. There are no term commitments or surprise charges.',
      },
    ],
  },
  {
    title: 'Concierge & Disco AI',
    items: [
      {
        q: 'What is Disco AI?',
        a: 'Disco AI is an AI-powered catering assistant built into the Disco Cater platform, powered by Anthropic\'s Claude. You can describe your event to Disco — the occasion, number of guests, cuisine preferences, budget, and delivery location — and Disco will recommend 2–3 restaurants with specific package options and pricing. Disco AI is available directly on the map page at discocater.com/fullmap.',
      },
      {
        q: 'What is the personal concierge service?',
        a: (
          <>
            Every Disco Cater customer has access to a dedicated concierge who can help you select the right restaurant and menu for your event, answer questions, and ensure your order goes smoothly from placement to delivery. Contact{' '}
            <a href="mailto:concierge@discocater.com" style={{ color: '#5B6FE8', textDecoration: 'none', fontWeight: 600 }}>concierge@discocater.com</a> and we will match you with the right person from our team.
          </>
        ),
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
              { n: '3', title: 'Multi-menu tech.', body: 'We support distinct office, holiday, social event, and meal prep catering menus — and advertise each more effectively to the right customers.' },
              { n: '4', title: 'Pricing.', body: 'Our pricing is typically lower than all of our competitors. 15% on a customer\'s first order, 5% on all recurring orders from that same customer.' },
              { n: '5', title: 'No risk.', body: 'There are no monthly or fixed fees to join Disco Cater, only the cost of your time — something we strive to minimize.' },
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
        q: 'Do I need to use Disco Cater as my 1st-party ordering platform?',
        a: "No, but it's the recommended path. If you use Disco Cater as your native catering platform, order management and payouts are handled seamlessly. Pricing is also reduced for partners using Disco Cater as their 1st-party ordering platform.",
      },
      {
        q: 'What are the next steps for joining?',
        a: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#555' }}>Create a free account on Disco Cater to get started:</p>
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
      <div className="faq-ans" style={{
          paddingBottom: open ? 20 : 0, paddingRight: 44,
          fontSize: 14, color: '#555', lineHeight: 1.7,
          fontFamily: "'DM Sans', sans-serif",
          maxHeight: open ? '2000px' : '0px',
          overflow: 'hidden',
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
        .faq-nav-link:hover { color: #6B6EF9 !important; }
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
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#888', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}>
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
        <div className="faq-cta" style={{ marginTop: 64, padding: '36px 32px', borderRadius: 20, background: '#fafafa', border: '1px solid #f0f0f0', textAlign: 'center' }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111', fontFamily: "'DM Sans', sans-serif", marginBottom: 8 }}>
            Still have questions?
          </h3>
          <p style={{ fontSize: 14, color: '#888', fontFamily: "'DM Sans', sans-serif", marginBottom: 20 }}>
            Our team is happy to help.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="mailto:concierge@discocater.com" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 22px', borderRadius: 24, background: '#5B6FE8', color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}>
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
          <a href="mailto:concierge@discocater.com" style={{ color: '#bbb', textDecoration: 'none' }}>Contact</a>
          {' · '}© {new Date().getFullYear()} Disco Cater
        </span>
      </footer>
    </>
  )

    </>
  )
}