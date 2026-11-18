import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../lib/customer-auth'
import { listForDiner } from '../../../../lib/promotions/diner-promotions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/customer/promotions — the signed-in diner's promotions (Account → Promotions, home card).
// The admin-only fields (internal note, who created it) are not sent.
export async function GET(req: NextRequest) {
  const session = await getCustomerSession(req)
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const list = await listForDiner(session.email)
  return NextResponse.json({
    promotions: list.map((p) => ({
      reference: p.reference, type: p.type, status: p.status, expiresOn: p.expiresOn,
      restaurantReference: p.restaurantReference, restaurantName: p.restaurantName, restaurantSlug: p.restaurantSlug,
      restaurantImage: p.restaurantImage, restaurantCity: p.restaurantCity, restaurantState: p.restaurantState,
      activatedAt: p.activatedAt, usedAt: p.usedAt, orderNumber: p.orderNumber,
    })),
  })
}
