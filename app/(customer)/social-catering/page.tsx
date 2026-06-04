import type { Metadata } from 'next'
import { UseCaseShell, Section, TagGrid, type FaqItem } from '../_usecase/ui'

export const metadata: Metadata = {
  title: 'Social Event & Party Catering — Disco Cater',
  description: 'Order catering for parties, celebrations, and social events from premium restaurants. Disco Cater makes social event catering easy with AI-powered discovery and exclusive menus.',
  alternates: { canonical: 'https://www.discocater.com/social-catering' },
}

const FAQ: FaqItem[] = [
  {
    q: 'What types of social events does Disco Cater serve?',
    a: 'Disco Cater serves all types of social events including birthday parties, baby showers, graduation celebrations, wedding receptions, networking events, and casual gatherings. Use Disco AI to describe your event and get personalized restaurant recommendations based on your guest count, cuisine preferences, and budget.',
  },
  {
    q: 'How does Disco Cater differ from ezCater for social events?',
    a: 'Disco Cater offers exclusive proprietary menus for social events not available on ezCater, charges no commission fees to customers, and features Disco AI — an AI-powered catering assistant for personalized discovery. Disco Cater also specializes in premium, independent restaurants rather than chain restaurants.',
  },
  {
    q: 'What is the minimum order for social event catering?',
    a: 'Minimum orders vary by restaurant. Most restaurants on Disco Cater have minimums between $100-$250. Use the catering map to filter by restaurant and review their specific minimums and lead time requirements.',
  },
]

export default function SocialCateringPage() {
  return (
    <UseCaseShell
      title="Social Event & Party Catering"
      slug="social-catering"
      ctaHeading="Find Social Event Catering"
      faq={FAQ}
    >
      <p>
        Disco Cater makes catering for social events, parties, and celebrations easy. Browse premium
        restaurants, get AI-powered recommendations from Disco AI, and order for events of any size — from
        intimate gatherings to large celebrations.
      </p>

      <Section heading="Events We Cater">
        <TagGrid items={[
          'Birthday Parties',
          'Baby Showers',
          'Graduation Parties',
          'Wedding Receptions',
          'Networking Events',
          'Fundraisers',
          'Sports Watching Parties',
          'Casual Get-Togethers',
        ]} />
      </Section>

      <Section heading="Disco AI for Social Events">
        <p>
          Describe your event and guest count, and Disco AI returns instant, personalized recommendations —
          matching the occasion, cuisine preferences, and budget to the right restaurants and packages so you
          can plan in minutes instead of hours.
        </p>
      </Section>
    </UseCaseShell>
  )
}
