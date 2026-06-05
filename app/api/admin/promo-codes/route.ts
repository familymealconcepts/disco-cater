import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

// GET /api/admin/promo-codes — list all codes (newest first).
export async function GET() {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  await runMigrations()
  const rows = await sql`SELECT * FROM promo_codes ORDER BY created_at DESC`
  return NextResponse.json({ codes: rows })
}

// POST /api/admin/promo-codes — create a code.
export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  await runMigrations()

  let b: Record<string, unknown>
  try { b = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const code = String(b.code || '').trim().toUpperCase()
  const discountType = b.discountType === 'percent' ? 'percent' : 'flat'
  const discountValue = typeof b.discountValue === 'number' ? b.discountValue : parseFloat(String(b.discountValue || 0))
  const scope = b.scope === 'restaurant' ? 'restaurant' : 'global'
  const restaurantRef = scope === 'restaurant' && b.restaurantRef ? String(b.restaurantRef) : null
  const maxUses = b.maxUses == null || b.maxUses === '' ? null : parseInt(String(b.maxUses), 10)
  const maxUsesPerUser = b.maxUsesPerUser == null || b.maxUsesPerUser === '' ? 1 : parseInt(String(b.maxUsesPerUser), 10)
  const firstTimeOnly = b.firstTimeOnly === true
  const minOrderSubtotal = b.minOrderSubtotal == null || b.minOrderSubtotal === '' ? null : parseFloat(String(b.minOrderSubtotal))
  const maxDiscountCap = discountType === 'percent' && b.maxDiscountCap != null && b.maxDiscountCap !== '' ? parseFloat(String(b.maxDiscountCap)) : null
  const validFrom = b.validFrom ? String(b.validFrom) : null
  const validUntil = b.validUntil ? String(b.validUntil) : null
  const notes = b.notes ? String(b.notes) : null

  if (!code) return NextResponse.json({ error: 'Code is required.' }, { status: 400 })
  if (!Number.isFinite(discountValue) || discountValue <= 0) return NextResponse.json({ error: 'Discount value must be greater than 0.' }, { status: 400 })
  if (scope === 'restaurant' && !restaurantRef) return NextResponse.json({ error: 'Pick a restaurant for a restaurant-scoped code.' }, { status: 400 })

  try {
    const rows = (await sql`
      INSERT INTO promo_codes (
        code, discount_type, discount_value, scope, restaurant_ref, max_uses,
        max_uses_per_user, first_time_only, min_order_subtotal, max_discount_cap,
        valid_from, valid_until, notes
      ) VALUES (
        ${code}, ${discountType}, ${discountValue}, ${scope}, ${restaurantRef}, ${maxUses},
        ${maxUsesPerUser}, ${firstTimeOnly}, ${minOrderSubtotal}, ${maxDiscountCap},
        ${validFrom ?? null}::timestamptz, ${validUntil}::timestamptz, ${notes}
      )
      RETURNING *
    `) as unknown[]
    return NextResponse.json({ code: rows[0] }, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/unique|duplicate/i.test(msg)) return NextResponse.json({ error: 'A code with that name already exists.' }, { status: 409 })
    return NextResponse.json({ error: 'Could not create promo code.' }, { status: 500 })
  }
}
