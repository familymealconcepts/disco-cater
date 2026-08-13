import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../../lib/db'
import { resolvePromoScope, isPromoRefAllowed, type PromoScope } from '../../../../../lib/restaurant-promo'
import { getRestaurantTimezone, localDayBoundaryToUTC } from '../../../../../lib/timezone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Confirm the code exists, is restaurant-funded, and belongs to a location the
// caller may manage. Returns the row's restaurant_ref or null.
async function ownedRestaurantRef(id: number, scope: PromoScope): Promise<string | null> {
  if (!Number.isFinite(id) || (!scope.unrestricted && !scope.allowedRefs.length)) return null
  const rows = (await sql`SELECT restaurant_ref FROM promo_codes WHERE id = ${id} AND funded_by = 'RESTAURANT' LIMIT 1`) as { restaurant_ref: string | null }[]
  const ref = rows[0]?.restaurant_ref || ''
  return ref && isPromoRefAllowed(scope, ref) ? ref : null
}

// PATCH — edit fields and/or toggle active. Any subset of:
// { active, discountType, discountValue, maxDiscountCap, minOrderSubtotal,
//   firstTimeOnly, notes, validFrom, validUntil, maxUses, maxUsesPerUser,
//   confirmHighDiscount }.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scope = await resolvePromoScope()
  if (!scope) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const id = parseInt((await params).id, 10)
    const ownedRef = await ownedRestaurantRef(id, scope)
    if (!ownedRef) {
      return NextResponse.json({ error: 'Promo code not found.' }, { status: 404 })
    }
    const body = await req.json().catch(() => ({}))

    const sets: string[] = []
    const vals: unknown[] = []
    const push = (frag: string, val: unknown) => { vals.push(val); sets.push(frag.replace('?', `$${vals.length}`)) }

    if (typeof body.active === 'boolean') push('active = ?', body.active)

    // discountType/discountValue must be considered together: a cap is only ever
    // meaningful for 'percent', and validating discountValue's range depends on
    // which type is in effect (existing row's type, unless this PATCH also changes it).
    let effectiveDiscountType: 'flat' | 'percent' | undefined
    if (body.discountType !== undefined) {
      effectiveDiscountType = body.discountType === 'flat' ? 'flat' : 'percent'
      push('discount_type = ?', effectiveDiscountType)
    }
    if (!effectiveDiscountType) {
      const existing = (await sql`SELECT discount_type FROM promo_codes WHERE id = ${id} LIMIT 1`) as { discount_type: 'flat' | 'percent' }[]
      effectiveDiscountType = existing[0]?.discount_type
    }
    if (body.discountValue !== undefined) {
      const v = Number(body.discountValue)
      if (effectiveDiscountType === 'percent') {
        if (!Number.isFinite(v) || v < 1 || v > 100) return NextResponse.json({ error: 'Discount must be a number between 1 and 100.' }, { status: 400 })
        if (v >= 90 && body.confirmHighDiscount !== true) {
          return NextResponse.json({ error: 'confirm_high_discount', requiresConfirmation: true }, { status: 409 })
        }
      } else {
        if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ error: 'Discount must be a dollar amount greater than 0.' }, { status: 400 })
      }
      push('discount_value = ?', v)
    }
    if (body.maxDiscountCap !== undefined) {
      const cap = body.maxDiscountCap === null || body.maxDiscountCap === '' ? null : Number(body.maxDiscountCap)
      if (cap != null && (!Number.isFinite(cap) || cap <= 0)) return NextResponse.json({ error: 'Max discount cap must be a dollar amount greater than 0.' }, { status: 400 })
      push('max_discount_cap = ?', effectiveDiscountType === 'percent' ? cap : null)
    }
    if (body.minOrderSubtotal !== undefined) {
      const m = body.minOrderSubtotal === null || body.minOrderSubtotal === '' ? null : Number(body.minOrderSubtotal)
      if (m != null && (!Number.isFinite(m) || m < 0)) return NextResponse.json({ error: 'Min order subtotal must be 0 or more.' }, { status: 400 })
      push('min_order_subtotal = ?', m)
    }
    if (typeof body.firstTimeOnly === 'boolean') push('first_time_only = ?', body.firstTimeOnly)
    if (body.notes !== undefined) push('notes = ?', body.notes ? String(body.notes).trim() : null)

    if (body.maxUses !== undefined) {
      const m = body.maxUses === null || body.maxUses === '' ? null : Math.trunc(Number(body.maxUses))
      if (m != null && (!Number.isInteger(m) || m < 1)) return NextResponse.json({ error: 'Max total uses must be a whole number of 1 or more, or left blank for unlimited.' }, { status: 400 })
      push('max_uses = ?', m)
    }
    if (body.maxUsesPerUser !== undefined) {
      const m = Math.trunc(Number(body.maxUsesPerUser))
      if (!Number.isInteger(m) || m < 1) return NextResponse.json({ error: 'Max uses per diner must be a whole number of 1 or more.' }, { status: 400 })
      push('max_uses_per_user = ?', m)
    }
    let validFromDate = ''
    let validUntilDate = ''
    let clearValidUntil = false
    if (body.validFrom !== undefined) {
      validFromDate = String(body.validFrom || '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(validFromDate)) return NextResponse.json({ error: 'Valid-from date is invalid.' }, { status: 400 })
    }
    if (body.validUntil !== undefined) {
      validUntilDate = String(body.validUntil || '').trim()
      if (validUntilDate && !/^\d{4}-\d{2}-\d{2}$/.test(validUntilDate)) return NextResponse.json({ error: 'Valid-until date is invalid.' }, { status: 400 })
      if (!validUntilDate) clearValidUntil = true // explicit blank = clear the optional end date
    }
    if (validFromDate && validUntilDate && validUntilDate < validFromDate) {
      return NextResponse.json({ error: 'Valid-until date must be on or after valid-from.' }, { status: 400 })
    }
    // Restaurant-LOCAL day boundaries, not UTC midnight — see lib/timezone.ts. Same
    // conversion as create; none of the other new fields are dates.
    if (validFromDate || validUntilDate || clearValidUntil) {
      const { timezone } = await getRestaurantTimezone(ownedRef)
      if (validFromDate) push('valid_from = ?::timestamptz', localDayBoundaryToUTC(validFromDate, timezone, false).toISOString())
      if (validUntilDate) push('valid_until = ?::timestamptz', localDayBoundaryToUTC(validUntilDate, timezone, true).toISOString())
      else if (clearValidUntil) push('valid_until = ?::timestamptz', null)
    }

    if (!sets.length) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })

    vals.push(id)
    const rows = (await sql.query(
      `UPDATE promo_codes SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`,
      vals,
    )) as { id: number }[]
    if (!rows.length) return NextResponse.json({ error: 'Promo code not found.' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[restaurant/promo-codes/[id]] PATCH failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update promo code' }, { status: 500 })
  }
}

// DELETE — remove a restaurant-funded code the caller owns.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scope = await resolvePromoScope()
  if (!scope) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const id = parseInt((await params).id, 10)
    if (!(await ownedRestaurantRef(id, scope))) {
      return NextResponse.json({ error: 'Promo code not found.' }, { status: 404 })
    }
    // A code that's been used is kept for its redemption history — deactivate
    // rather than delete so /api/promo/validate stops honoring it.
    const used = (await sql`SELECT uses_count FROM promo_codes WHERE id = ${id} LIMIT 1`) as { uses_count: number }[]
    if ((used[0]?.uses_count ?? 0) > 0) {
      await sql`UPDATE promo_codes SET active = false WHERE id = ${id}`
      return NextResponse.json({ ok: true, deactivated: true })
    }
    await sql`DELETE FROM promo_codes WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[restaurant/promo-codes/[id]] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to delete promo code' }, { status: 500 })
  }
}
