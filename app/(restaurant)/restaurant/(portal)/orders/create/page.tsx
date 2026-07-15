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
  try {
    const res = await fetch(`${FM}/public-api/restaurants`, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } })
    if (res.ok) {
      const list: { reference: string; businessNameWithoutSpaces?: string }[] = await res.json()
      fmSlug = list.find(r => r.reference === restaurantRef)?.businessNameWithoutSpaces ?? null
    }
  } catch {}

  // Disco-native restaurants aren't in FM's public list, so the lookup above finds
  // nothing and Create Order was dead-ended (RH4). Resolve their ordering slug from
  // Neon instead — /order/[slug] renders native restaurants directly from Neon
  // (RestaurantView → loadDiscoNativeRestaurant), so direct-entry works for them.
  if (!fmSlug) {
    try {
      const rows = (await sql`
        SELECT slug FROM disco_restaurant_cache
        WHERE restaurant_reference = ${restaurantRef} AND slug IS NOT NULL AND is_disco_native = true
        LIMIT 1
      `) as { slug: string | null }[]
      fmSlug = rows[0]?.slug ?? null
    } catch { /* leave null → the modal shows the not-found notice */ }
  }

  return <CreateOrderMethodModal fmSlug={fmSlug} />
}
