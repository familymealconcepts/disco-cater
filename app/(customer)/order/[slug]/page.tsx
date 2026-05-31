import type { Metadata } from 'next'
import { buildRestaurantMetadata, RestaurantView } from '../../restaurants/[slug]/shared'

// 1st-party direct ordering route. Identical UI to /restaurants/[slug] — it
// reuses the exact same RestaurantView + CheckoutDrawer — but passes
// isFirstParty so checkout sends sourceoforder "FAMILYMEAL" (1P → no lead-gen
// fee). Restaurants share this link on their own site (commission-free).
// noindex + canonical→/restaurants so it doesn't compete with the marketplace
// page in search (handled in buildRestaurantMetadata).

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  return buildRestaurantMetadata(slug, { basePath: '/order', noindex: true })
}

export default async function OrderPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return <RestaurantView slug={slug} isFirstParty />
}
