import type { Metadata } from 'next'
import { buildRestaurantMetadata, RestaurantView } from '../../../restaurants/[slug]/shared'

// 1st-party direct ordering, opened on a SPECIFIC menu:
//   /order/{restaurant-slug}/{menu-slug}
//
// ── WHY THIS FILE HAS TO EXIST ──────────────────────────────────────────────
// There was no route of this shape at all. /order/[slug] matches exactly one
// segment, so /order/maciels/thanksgiving matched nothing and returned a hard
// 404 — the menu slug was not "ignored", it was never routed. Every restaurant
// with more than one menu was affected (Maciel's has 3 visible, Panatieri's 19,
// Little Chef 16, Colonial Ranch 15), and the only workaround was reordering
// menus so the wanted one sat first, which is what ops had to do.
//
// Identical to /order/[slug] in every other respect — same RestaurantView, same
// isFirstParty (so checkout still records FAMILYMEAL / 1P, no lead-gen), same
// noindex + canonical. The ONLY difference is which menu the page opens on.
//
// An unknown menu slug falls back to the restaurant's default menu rather than
// 404ing, because these links are printed and shared externally and a renamed
// or seasonally-retired menu must still land the customer on the restaurant.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; menu: string }>
}): Promise<Metadata> {
  const { slug } = await params
  return buildRestaurantMetadata(slug, { basePath: '/order', noindex: true })
}

export default async function OrderMenuPage({
  params,
}: {
  params: Promise<{ slug: string; menu: string }>
}) {
  const { slug, menu } = await params
  return <RestaurantView slug={slug} isFirstParty menuSlug={menu} />
}
