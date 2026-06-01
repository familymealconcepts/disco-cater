import { redirect } from 'next/navigation'
import { getRestaurantRef, getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import CreateOrderClient from './CreateOrderClient'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Direct Entry / Create Order — restaurant staff place an order on behalf of a
// customer. Server component resolves the restaurant ref (single-location ADMIN
// from the JWT; SYSTEM_ADMIN from the selected-location cookie) and preloads the
// menu, then hands off to the client wizard.
export default async function CreateOrderPage() {
  const role = await getRestaurantRole()
  if (!role) redirect('/restaurant/login')

  // getRestaurantRef returns null for a SYSTEM_ADMIN with no location picked —
  // they must select one first, exactly like the rest of the portal.
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) redirect('/restaurant/select-location')

  // Public menu endpoint — same source the customer order flow uses, so the
  // package + modifier shape (extraItemsGroups[].addOns[]) matches what the
  // checkout payload builder expects. No auth needed.
  let packages: unknown[] = []
  try {
    const res = await fetch(`${FM}/public-api/restaurants/${restaurantRef}/mealPackages`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 300 },
    })
    if (res.ok) {
      const data = await res.json()
      packages = Array.isArray(data) ? data : []
    }
  } catch {}

  return <CreateOrderClient restaurantRef={restaurantRef} packages={packages as never[]} />
}
