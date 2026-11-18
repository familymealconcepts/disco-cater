import { NextRequest, NextResponse } from 'next/server'
import { verifySuperAdmin } from '../../../../lib/admin-auth'
import { createPromotion, listPromotions, PROMOTION_STATUSES, type PromotionStatus } from '../../../../lib/promotions/diner-promotions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/promotions?diner=&restaurant=&status=&createdBy= — Super Admin → Promotions list.
export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin()
  if (!auth.ok) return NextResponse.json({ error: 'Not authenticated' }, { status: auth.status })
  const sp = req.nextUrl.searchParams
  const status = (sp.get('status') || '').toUpperCase()
  const promotions = await listPromotions({
    diner: sp.get('diner') || undefined,
    restaurant: sp.get('restaurant') || undefined,
    createdBy: sp.get('createdBy') || undefined,
    status: (PROMOTION_STATUSES as string[]).includes(status) ? status as PromotionStatus : '',
  })
  return NextResponse.json({ promotions })
}

// POST /api/admin/promotions { customerId, restaurantReference, expiresOn?, note?, emailDiner } — give one.
export async function POST(req: NextRequest) {
  const auth = await verifySuperAdmin()
  if (!auth.ok) return NextResponse.json({ error: 'Not authenticated' }, { status: auth.status })
  let b: Record<string, unknown>
  try { b = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const customerId = Number(b.customerId)
  const restaurantReference = String(b.restaurantReference || '')
  if (!Number.isInteger(customerId) || customerId <= 0) return NextResponse.json({ error: 'Pick a diner.' }, { status: 400 })
  if (!/^[0-9a-f-]{36}$/i.test(restaurantReference)) return NextResponse.json({ error: 'Pick a restaurant.' }, { status: 400 })
  const r = await createPromotion({
    customerId, restaurantReference, type: 'FREE_DELIVERY',
    expiresOn: typeof b.expiresOn === 'string' ? b.expiresOn : null,
    note: typeof b.note === 'string' ? b.note : null,
    emailDiner: b.emailDiner !== false,
    createdBy: auth.email,
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ promotion: r.promotion, emailed: r.emailed })
}
