import { redirect } from 'next/navigation'
import { getRestaurantRef, getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import CreateOrderMethodModal from './CreateOrderClient'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

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

  return <CreateOrderMethodModal fmSlug={fmSlug} />
}
