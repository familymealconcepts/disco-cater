import type { Metadata } from 'next'
import { UseCaseShell, Section, TagGrid, type FaqItem } from '../_usecase/ui'

export const metadata: Metadata = {
  title: 'Meal Prep & Subscription Catering for Teams — Disco Cater',
  description: 'Set up recurring meal prep and subscription catering for your team. Disco Cater connects you with premium restaurants for weekly meal programs, healthy office lunches, and recurring team meals.',
  alternates: { canonical: 'https://www.discocater.com/meal-prep' },
}

const FAQ: FaqItem[] = [
  {
    q: 'Can I set up weekly meal prep catering through Disco Cater?',
    a: 'Yes. Disco Cater supports recurring catering subscriptions for teams that need regular meal delivery. You can set up weekly or monthly catering from premium restaurants and manage your program from one dashboard.',
  },
  {
    q: 'What restaurants offer meal prep catering on Disco Cater?',
    a: 'Disco Cater features 700+ hand-vetted restaurant partners across the United States, including restaurants specializing in healthy, high-volume, and recurring meal programs. Use the catering map or Disco AI to find restaurants near you that offer meal prep catering.',
  },
  {
    q: 'How is Disco Cater different from meal kit services for teams?',
    a: 'Unlike meal kit services, Disco Cater connects you with real local restaurants that cater. You get restaurant-quality food, flexible portion sizes for your team, and no assembly required. Restaurants on Disco Cater specialize in catering — not consumer delivery — so the food is designed to travel well and serve groups.',
  },
]

export default function MealPrepPage() {
  return (
    <UseCaseShell
      title="Meal Prep & Subscription Catering for Teams"
      slug="meal-prep"
      ctaHeading="Browse Meal Prep Catering"
      faq={FAQ}
    >
      <p>
        Disco Cater supports recurring meal prep and subscription catering programs for office teams, wellness
        programs, and organizations that need reliable, high-quality food delivery on a schedule. Set up weekly
        or monthly catering from premium restaurants and manage everything in one place.
      </p>

      <Section heading="Built for Recurring Programs">
        <TagGrid items={[
          'Weekly office lunches',
          'Monthly team meals',
          'Wellness catering programs',
          'Rotating menus to prevent fatigue',
        ]} />
      </Section>

      <Section heading="Why Teams Choose Disco Cater for Meal Prep">
        <TagGrid items={[
          'No commission fees',
          'Premium restaurants (not chains)',
          'Disco AI for menu variety recommendations',
          'Easy rescheduling and management',
        ]} />
      </Section>
    </UseCaseShell>
  )
}
