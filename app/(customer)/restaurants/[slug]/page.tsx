import type { Metadata } from 'next'
import { buildRestaurantMetadata, RestaurantView } from './shared'

// 3rd-party marketplace route. Renders the shared restaurant page WITHOUT
// isFirstParty, so checkout sends sourceoforder "DISCO" (3P → lead-gen fee
// applies). This is the public, indexable SEO page. See ./shared.tsx and
// /order/[slug] for the 1st-party (commission-free) counterpart.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  return buildRestaurantMetadata(slug, { basePath: '/restaurants' })
}

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return <RestaurantView slug={slug} />
}
