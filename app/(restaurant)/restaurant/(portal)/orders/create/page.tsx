import { redirect } from 'next/navigation'
import { getRestaurantRef, getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import { sql } from '../../../../../../lib/db'
import CreateOrderMethodModal from './CreateOrderClient'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const dynamic = 'force-dynamic'

// Direct Entry / Create Order — entry point. Mirrors FM exactly: the method
// choice (Payment vs Invoice) just routes the admin into the normal 1st-party
// ordering page (/order/[slug]) with a ?mode=direct-entry flag. There is NO
// separate order-builder UI — the customer-facing page IS the builder.
//
// The /order/[slug] route resolves a restaurant by slug (Sanity slug or FM
// businessNameWithoutSpaces), not by UUID, so we reverse-look-up the portal's
// restaurant reference against the public list to get its slug.
export default async function CreateOrderPage() {
  const role = await getRestaurantRole()
  if (!role) redirect('/restaurant/login')

  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) redirect('/restaurant/select-location')

  let fmSlug: string | null = null
  let restaurantName: string | null = null
  try {
    const res = await fetch(`${FM}/public-api/restaurants`, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } })
    if (res.ok) {
      const list: { reference: string; businessNameWithoutSpaces?: string; businessName?: string }[] = await res.json()
      const match = list.find(r => r.reference === restaurantRef)
      fmSlug = match?.businessNameWithoutSpaces ?? null
      restaurantName = match?.businessName ?? null
    }
  } catch {}

  // Fill the display name from Neon, and resolve the ordering slug for Disco-native
  // restaurants (not in FM's public list — RH4). The name is shown in the Create
  // Order modal so a stale selected location is obvious before submitting (RM4).
  try {
    const rows = (await sql`
      SELECT name, slug, is_disco_native FROM disco_restaurant_cache
      WHERE restaurant_reference = ${restaurantRef} LIMIT 1
    `) as { name: string | null; slug: string | null; is_disco_native: boolean | null }[]
    const c = rows[0]
    if (!fmSlug && c?.is_disco_native && c?.slug) fmSlug = c.slug
    if (!restaurantName) restaurantName = c?.name ?? null
  } catch { /* leave null → the modal shows the not-found notice / generic label */ }

  return <CreateOrderMethodModal fmSlug={fmSlug} restaurantName={restaurantName} />
}
