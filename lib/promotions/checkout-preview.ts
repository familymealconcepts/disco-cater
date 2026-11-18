// Does the checkout preview (/api/order/init|update, Disco-native restaurants) price this cart with
// the signed-in diner's free-delivery promotion? The same lookup placement makes
// (native-place-checkout.ts), so the total the diner is shown is the total they are charged.
// Never for direct entry: staff placing an order for someone else never use a diner's promotion.
import type { NextRequest } from 'next/server'
import { getCustomerSession } from '../customer-auth'
import { findActivatedFreeDelivery } from './diner-promotions'

export async function previewHasFreeDelivery(req: NextRequest, restaurantRef: string, body: Record<string, unknown>): Promise<boolean> {
  if (body?.discoDirectEntry === true || !restaurantRef) return false
  const session = await getCustomerSession(req).catch(() => null)
  if (!session?.email) return false
  return !!(await findActivatedFreeDelivery(session.email, restaurantRef))
}
