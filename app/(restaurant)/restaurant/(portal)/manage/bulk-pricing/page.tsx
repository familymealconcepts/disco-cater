import { redirect } from 'next/navigation'
import { getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import BulkPricingClient from './BulkPricingClient'

// SYSTEM_ADMIN-only tool to find a menu item across all locations and update its
// price everywhere. ADMIN (single-location) users are bounced to Orders.
export default async function BulkPricingPage() {
  const role = await getRestaurantRole()
  if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') redirect('/restaurant/orders')
  return <BulkPricingClient />
}
