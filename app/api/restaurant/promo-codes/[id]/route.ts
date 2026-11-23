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

// The rows an edit, deactivate or delete applies to (Peter, 2026-11-23): a code created at several locations at once shares
// group_ref, and acts as ONE code — every row of its group that the caller may manage. A one-location code is just itself.
// Never widens access: each row is still checked with isPromoRefAllowed.
async function targetRows(id: number, scope: PromoScope): Promise<{ id: number; ref: string }[]> {
  const rows = (await sql`
    SELECT p.id, p.restaurant_ref FROM promo_codes p
    WHERE p.funded_by = 'RESTAURANT'
      AND (p.id = ${id} OR (p.group_ref IS NOT NULL AND p.group_ref = (SELECT g.group_ref FROM promo_codes g WHERE g.id = ${id})))
  `) as { id: number; restaurant_ref: string | null }[]
  return rows.filter((r) => r.restaurant_ref && isPromoRefAllowed(scope, r.restaurant_ref)).map((r) => ({ id: Number(r.id), ref: String(r.restaurant_ref) }))
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
    // Every row this edit applies to: the code itself, or all of its group the caller may manage.
    const targets = await targetRows(id, scope)
    if (!targets.length) return NextResponse.json({ error: 'Promo code not found.' }, { status: 404 })

    // Restaurant-LOCAL day boundaries, not UTC midnight — see lib/timezone.ts. Same
    // conversion as create; none of the other new fields are dates. Each location's own zone, so a grouped code's dates
    // mean the same local day everywhere; they travel per row in the VALUES list below.
    const perRow = new Map<number, { vf: string | null; vu: string | null }>()
    if (validFromDate || validUntilDate) {
      for (const t of targets) {
        const { timezone } = await getRestaurantTimezone(t.ref)
        perRow.set(t.id, {
          vf: validFromDate ? localDayBoundaryToUTC(validFromDate, timezone, false).toISOString() : null,
          vu: validUntilDate ? localDayBoundaryToUTC(validUntilDate, timezone, true).toISOString() : null,
        })
      }
      if (validFromDate) sets.push('valid_from = v.vf')
      if (validUntilDate) sets.push('valid_until = v.vu')
    }
    if (!validUntilDate && clearValidUntil) sets.push('valid_until = NULL')

    if (!sets.length) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })

    // ONE statement for every target row (no transactions on this connection), so a grouped code never ends up half-edited.
    const tuples = targets.map((t) => {
      const d = perRow.get(t.id) ?? { vf: null, vu: null }
      vals.push(t.id, d.vf, d.vu)
      return `($${vals.length - 2}::int, $${vals.length - 1}::timestamptz, $${vals.length}::timestamptz)`
    })
    const rows = (await sql.query(
      `UPDATE promo_codes p SET ${sets.join(', ')} FROM (VALUES ${tuples.join(', ')}) AS v(id, vf, vu) WHERE p.id = v.id RETURNING p.id`,
      vals,
    )) as { id: number }[]
    if (!rows.length) return NextResponse.json({ error: 'Promo code not found.' }, { status: 404 })
    return NextResponse.json({ ok: true, updated: rows.length })
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
    // A grouped code is deleted as one: every row of its group the caller may manage.
    const ids = (await targetRows(id, scope)).map((t) => t.id)
    // A code that's been used is kept for its redemption history — deactivate
    // rather than delete so /api/promo/validate stops honoring it. Decided per location.
    const used = (await sql`SELECT id FROM promo_codes WHERE id = ANY(${ids}::int[]) AND uses_count > 0`) as { id: number }[]
    const usedIds = used.map((u) => Number(u.id))
    const unusedIds = ids.filter((x) => !usedIds.includes(x))
    if (usedIds.length) await sql`UPDATE promo_codes SET active = false WHERE id = ANY(${usedIds}::int[])`
    if (unusedIds.length) await sql`DELETE FROM promo_codes WHERE id = ANY(${unusedIds}::int[])`
    return NextResponse.json({ ok: true, deactivated: usedIds.length > 0, deactivatedCount: usedIds.length, deletedCount: unusedIds.length })
  } catch (err) {
    console.error('[restaurant/promo-codes/[id]] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to delete promo code' }, { status: 500 })
  }
}
