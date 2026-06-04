import type { Metadata } from 'next'
import { UseCaseShell, Section, FeatureGrid, FeatureCard, Steps, type FaqItem } from '../_usecase/ui'

export const metadata: Metadata = {
  title: 'Corporate Catering & Recurring Office Meal Programs — Disco Cater',
  description: 'Order recurring corporate catering from premium restaurants nationwide. Disco Cater specializes in office lunch programs, team meals, and recurring catering subscriptions for companies like Amazon, Meta, and IBM.',
  alternates: { canonical: 'https://www.discocater.com/corporate-catering' },
}

const FAQ: FaqItem[] = [
  {
    q: 'What is corporate catering through Disco Cater?',
    a: 'Disco Cater is a nationwide premium restaurant catering marketplace that connects corporate teams with hand-vetted restaurants for office lunches, team events, and recurring meal programs. Unlike ezCater, Disco Cater charges no commission to customers and features exclusive proprietary menus not available anywhere else.',
  },
  {
    q: 'Can I set up recurring office catering?',
    a: 'Yes. Disco Cater supports recurring catering subscriptions for office teams. You can schedule weekly or monthly catering from your favorite restaurants and manage everything from one dashboard.',
  },
  {
    q: 'How much does corporate catering cost on Disco Cater?',
    a: 'Disco Cater charges customers a 3% convenience fee. There are no commission fees, no monthly fees, and no minimum order requirements. The average corporate catering order on Disco Cater is $450.',
  },
]

export default function CorporateCateringPage() {
  return (
    <UseCaseShell
      title="Corporate Catering & Recurring Office Meal Programs"
      slug="corporate-catering"
      ctaHeading="Find Corporate Catering Near You"
      faq={FAQ}
    >
      <p>
        Disco Cater connects corporate teams with premium restaurant catering nationwide. The platform
        specializes in recurring office lunch programs, team meals, and event catering for companies of all
        sizes — from five-person startups to enterprise organizations ordering for hundreds.
      </p>
      <p>
        Enterprise clients include Amazon, Meta, IBM, J.P. Morgan, Coca-Cola, and the New York Giants, with an
        average order value of $450. There are no commission fees for customers — just hand-vetted restaurants,
        exclusive menus, and AI-powered discovery with Disco AI.
      </p>

      <Section heading="Why Corporate Teams Choose Disco Cater">
        <FeatureGrid>
          <FeatureCard title="Recurring programs">
            Set up weekly or monthly office catering on autopilot, so your team is fed on a reliable schedule
            without the manual reordering.
          </FeatureCard>
          <FeatureCard title="Premium restaurants">
            Every restaurant is hand-vetted for catering quality — real local kitchens, not fast-food chains.
          </FeatureCard>
          <FeatureCard title="No hidden fees">
            A flat 3% convenience fee, and that&apos;s it. No commissions, no monthly fees, no surprises at
            checkout.
          </FeatureCard>
          <FeatureCard title="Disco AI">
            Describe your team&apos;s size, cuisine preferences, and budget, and get personalized restaurant
            recommendations instantly.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section heading="How It Works">
        <Steps steps={[
          'Search by location to see premium catering restaurants near your office.',
          'Browse menus and order — review packages, pricing, and lead times, then check out.',
          'Schedule recurring or one-time delivery and manage everything from one dashboard.',
        ]} />
      </Section>
    </UseCaseShell>
  )
}
