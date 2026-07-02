import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../../lib/db'
import { resolvePromoScope } from '../../../../../lib/restaurant-promo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Confirm the code exists, is restaurant-funded, and belongs to a location the
// caller may manage. Returns the row's restaurant_ref or null.
async function ownedRestaurantRef(id: number, allowedRefs: string[]): Promise<string | null> {
  if (!Number.isFinite(id) || !allowedRefs.length) return null
  const rows = (await sql`SELECT restaurant_ref FROM promo_codes WHERE id = ${id} AND funded_by = 'RESTAURANT' LIMIT 1`) as { restaurant_ref: string | null }[]
  const ref = rows[0]?.restaurant_ref || ''
  return ref && allowedRefs.includes(ref) ? ref : null
}

// PATCH — edit fields and/or toggle active. Any subset of:
// { active, discountPercentage, startDate, endDate, maxAvailable, maxPerDiner }.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scope = await resolvePromoScope()
  if (!scope) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const id = parseInt((await params).id, 10)
    if (!(await ownedRestaurantRef(id, scope.allowedRefs))) {
      return NextResponse.json({ error: 'Promo code not found.' }, { status: 404 })
    }
    const body = await req.json().catch(() => ({}))

    const sets: string[] = []
    const vals: unknown[] = []
    const push = (frag: string, val: unknown) => { vals.push(val); sets.push(frag.replace('?', `$${vals.length}`)) }

    if (typeof body.active === 'boolean') push('active = ?', body.active)

    if (body.discountPercentage !== undefined) {
      const pct = Number(body.discountPercentage)
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) return NextResponse.json({ error: 'Discount must be a number between 1 and 100.' }, { status: 400 })
      push('discount_value = ?', pct)
    }
    if (body.maxAvailable !== undefined) {
      const m = Math.trunc(Number(body.maxAvailable))
      if (!Number.isFinite(m) || m < 1) return NextResponse.json({ error: 'Max available must be a whole number of 1 or more.' }, { status: 400 })
      push('max_uses = ?', m)
    }
    if (body.maxPerDiner !== undefined) {
      const m = Math.trunc(Number(body.maxPerDiner))
      if (!Number.isFinite(m) || m < 1) return NextResponse.json({ error: 'Max per diner must be a whole number of 1 or more.' }, { status: 400 })
      push('max_uses_per_user = ?', m)
    }
    let start = ''
    let end = ''
    if (body.startDate !== undefined) {
      start = String(body.startDate || '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return NextResponse.json({ error: 'Start date is invalid.' }, { status: 400 })
      push('valid_from = ?::timestamptz', start)
    }
    if (body.endDate !== undefined) {
      end = String(body.endDate || '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return NextResponse.json({ error: 'End date is invalid.' }, { status: 400 })
      push('valid_until = ?::timestamptz', end)
    }
    if (start && end && end < start) return NextResponse.json({ error: 'End date must be on or after the start date.' }, { status: 400 })

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
    if (!(await ownedRestaurantRef(id, scope.allowedRefs))) {
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
