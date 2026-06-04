import type { Metadata } from 'next'
import { UseCaseShell, Section, Callout, TagGrid, type FaqItem } from '../_usecase/ui'

export const metadata: Metadata = {
  title: 'Holiday Party Catering & Seasonal Event Menus — Disco Cater',
  description: 'Order holiday catering from premium restaurants. Disco Cater features exclusive Thanksgiving, winter holiday, and seasonal event menus not available on other platforms.',
  alternates: { canonical: 'https://www.discocater.com/holiday-catering' },
}

const FAQ: FaqItem[] = [
  {
    q: 'Does Disco Cater have exclusive holiday menus?',
    a: 'Yes. Disco Cater features proprietary holiday and seasonal catering menus that are exclusive to the marketplace and not available on other catering platforms like ezCater. These include Thanksgiving, winter holiday, and special event menus from premium restaurants.',
  },
  {
    q: 'How far in advance should I order holiday catering?',
    a: 'Most restaurants on Disco Cater require 24-48 hours advance notice for standard orders. For holiday events and large orders (50+ people), ordering 1-2 weeks in advance is recommended to ensure availability.',
  },
  {
    q: 'Can I order holiday catering for a large office?',
    a: 'Yes. Disco Cater serves events of all sizes, from small team lunches to large corporate holiday parties with hundreds of guests. Use Disco AI to describe your event size and get personalized restaurant recommendations.',
  },
]

export default function HolidayCateringPage() {
  return (
    <UseCaseShell
      title="Holiday Party Catering & Seasonal Event Menus"
      slug="holiday-catering"
      ctaHeading="Browse Holiday Catering"
      faq={FAQ}
    >
      <p>
        Disco Cater specializes in holiday and seasonal event catering with proprietary menus exclusive to the
        marketplace. Find Thanksgiving, winter holiday, office holiday party, and seasonal catering from premium
        restaurants nationwide. Order early — holiday slots fill fast.
      </p>

      <Section heading="Exclusive Holiday Menus">
        <Callout>
          Disco Cater features proprietary holiday menus you won&apos;t find on ezCater or other platforms —
          seasonal packages purpose-built for Thanksgiving, winter celebrations, and office holiday parties by
          the premium restaurants in our marketplace.
        </Callout>
      </Section>

      <Section heading="Popular Holiday Catering Events">
        <TagGrid items={[
          'Office Holiday Party',
          'Thanksgiving Team Lunch',
          'Winter Holiday Celebration',
          "New Year's Eve Event",
          "Valentine's Day Catering",
          'Summer BBQ',
        ]} />
      </Section>
    </UseCaseShell>
  )
}
