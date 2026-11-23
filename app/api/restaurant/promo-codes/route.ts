import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { cookies } from 'next/headers'
import { SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { sql, runMigrations } from '../../../../lib/db'
import { resolvePromoScope, isPromoRefAllowed } from '../../../../lib/restaurant-promo'
import { getRestaurantTimezone, localDayBoundaryToUTC } from '../../../../lib/timezone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Map a promo_codes row to the restaurant-portal shape — same field naming as the
// admin builder (discountType/discountValue/maxDiscountCap/minOrderSubtotal/
// firstTimeOnly/notes) so the two builders share one wire contract, not two.
function toApiCode(r: Record<string, unknown>) {
  const maxUses = r.max_uses == null ? null : Number(r.max_uses)
  const uses = Number(r.uses_count || 0)
  const isoDay = (v: unknown) => (v ? String(v).slice(0, 10) : '')
  return {
    id: Number(r.id),
    code: String(r.code),
    discountType: r.discount_type === 'flat' ? 'flat' : 'percent',
    discountValue: Number(r.discount_value),
    maxDiscountCap: r.max_discount_cap == null ? null : Number(r.max_discount_cap),
    minOrderSubtotal: r.min_order_subtotal == null ? null : Number(r.min_order_subtotal),
    firstTimeOnly: r.first_time_only === true,
    validFrom: isoDay(r.valid_from),
    validUntil: isoDay(r.valid_until),
    maxUses,
    remainingUses: maxUses == null ? null : Math.max(0, maxUses - uses),
    maxUsesPerUser: Number(r.max_uses_per_user || 1),
    notes: r.notes ? String(r.notes) : '',
    active: r.active === true,
    restaurantRef: r.restaurant_ref ? String(r.restaurant_ref) : '',
    // Codes created together at several locations share this (null for a one-location code).
    groupRef: r.group_ref ? String(r.group_ref) : null,
    usesCount: uses,
    restaurantName: r.restaurant_name ? String(r.restaurant_name) : '',
    moneyFlow: r.money_flow ? String(r.money_flow) : null,
  }
}

// GET — list restaurant-funded promo codes across the caller's in-scope locations.
// Optional ?restaurantReference filters to one in-scope location.
export async function GET(req: NextRequest) {
  const scope = await resolvePromoScope()
  if (!scope) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()

    const queryRef = (req.nextUrl.searchParams.get('restaurantReference') || '').trim()
    const store = await cookies()
    const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value || ''
    // ADMIN → own only. SA → filter to the queried/selected location if it's in
    // scope, otherwise all in-scope locations.
    let refs = scope.allowedRefs
    const focus = queryRef || (scope.isSystemAdmin ? selected : '')
    if (focus && isPromoRefAllowed(scope, focus)) refs = [focus]

    // NOTE: a disco-native SUPER_ADMIN with no explicit ?restaurantReference/
    // selected-location focus falls through to `scope.allowedRefs` here, which
    // is empty for that role (see resolvePromoScope) — this list/location-
    // dropdown only shows a specific focused location, never "every
    // restaurant," pending a real list-all-restaurants query. Documented
    // deliberately-deferred read-path gap; see lib/restaurant-write-scope.ts.
    if (!refs.length) {
      return NextResponse.json({ role: scope.role, isSystemAdmin: scope.isSystemAdmin, codes: [], locations: [] })
    }

    const placeholders = refs.map((_, i) => `$${i + 1}`).join(',')
    const rows = (await sql.query(
      `SELECT p.*, c.name AS restaurant_name, o.money_flow
       FROM promo_codes p
       LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = p.restaurant_ref
       LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = p.restaurant_ref
       WHERE p.funded_by = 'RESTAURANT' AND p.restaurant_ref IN (${placeholders})
       ORDER BY p.created_at DESC`,
      refs,
    )) as Record<string, unknown>[]

    // Location list (for the SA location column filter + create dropdown).
    let locations: { reference: string; name: string; moneyFlow: string | null }[] = []
    if (scope.isSystemAdmin) {
      const lp = scope.allowedRefs.map((_, i) => `$${i + 1}`).join(',')
      const locRows = scope.allowedRefs.length
        ? ((await sql.query(
            `SELECT c.restaurant_reference AS reference, COALESCE(c.name,'') AS name, o.money_flow
             FROM disco_restaurant_cache c
             LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
             WHERE c.restaurant_reference IN (${lp})
             ORDER BY c.name ASC`,
            scope.allowedRefs,
          )) as Record<string, unknown>[])
        : []
      locations = locRows.map(l => ({ reference: String(l.reference), name: String(l.name || ''), moneyFlow: l.money_flow ? String(l.money_flow) : null }))
    }

    return NextResponse.json({
      role: scope.role,
      isSystemAdmin: scope.isSystemAdmin,
      codes: rows.map(toApiCode),
      locations,
    })
  } catch (err) {
    console.error('[restaurant/promo-codes] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch promo codes' }, { status: 500 })
  }
}

// POST — create a restaurant-funded promo code (Neon-native; funded_by='RESTAURANT').
export async function POST(req: NextRequest) {
  const scope = await resolvePromoScope()
  if (!scope) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const body = await req.json().catch(() => ({}))

    // Target locations: a SYSTEM_ADMIN MUST name at least one explicit in-scope location (several since 2026-11-23:
    // restaurantReferences[], or the older single restaurantReference); an ADMIN always uses their own. Codes never apply
    // restaurant-wide by accident, and every location is checked against the caller's own scope, exactly as before.
    let restaurantRefs: string[] = [scope.ownRef]
    if (scope.isSystemAdmin) {
      const list: unknown[] = Array.isArray(body?.restaurantReferences) ? body.restaurantReferences : body?.restaurantReference ? [body.restaurantReference] : []
      restaurantRefs = [...new Set(list.map((r) => String(r || '').trim()).filter(Boolean))]
      if (!restaurantRefs.length) return NextResponse.json({ error: 'Select at least one location for this promo code.' }, { status: 400 })
    }
    if (restaurantRefs.some((ref) => !UUID_RE.test(ref) || !isPromoRefAllowed(scope, ref))) {
      return NextResponse.json({ error: 'You don’t have access to that location.' }, { status: 403 })
    }

    const code = String(body?.code || '').trim().toUpperCase()
    const discountType = body?.discountType === 'flat' ? 'flat' : 'percent'
    const discountValue = Number(body?.discountValue)
    const maxDiscountCap = discountType === 'percent' && body?.maxDiscountCap != null && body.maxDiscountCap !== '' ? Number(body.maxDiscountCap) : null
    const minOrderSubtotal = body?.minOrderSubtotal != null && body.minOrderSubtotal !== '' ? Number(body.minOrderSubtotal) : null
    const firstTimeOnly = body?.firstTimeOnly === true
    const maxUses = body?.maxUses != null && body.maxUses !== '' ? Math.trunc(Number(body.maxUses)) : null
    const maxUsesPerUser = body?.maxUsesPerUser != null && body.maxUsesPerUser !== '' ? Math.trunc(Number(body.maxUsesPerUser)) : 1
    const validFromDate = String(body?.validFrom || '').trim()
    const validUntilDate = String(body?.validUntil || '').trim()
    const notes = body?.notes ? String(body.notes).trim() : null

    if (!code || !/^[A-Z0-9]+$/.test(code)) {
      return NextResponse.json({ error: 'Code must be uppercase letters and numbers only.' }, { status: 400 })
    }
    if (discountType === 'percent') {
      if (!Number.isFinite(discountValue) || discountValue < 1 || discountValue > 100) {
        return NextResponse.json({ error: 'Discount must be a number between 1 and 100.' }, { status: 400 })
      }
    } else {
      if (!Number.isFinite(discountValue) || discountValue <= 0) {
        return NextResponse.json({ error: 'Discount must be a dollar amount greater than 0.' }, { status: 400 })
      }
    }
    if (maxDiscountCap != null && (!Number.isFinite(maxDiscountCap) || maxDiscountCap <= 0)) {
      return NextResponse.json({ error: 'Max discount cap must be a dollar amount greater than 0.' }, { status: 400 })
    }
    if (minOrderSubtotal != null && (!Number.isFinite(minOrderSubtotal) || minOrderSubtotal < 0)) {
      return NextResponse.json({ error: 'Min order subtotal must be 0 or more.' }, { status: 400 })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFromDate)) {
      return NextResponse.json({ error: 'Valid-from date is required.' }, { status: 400 })
    }
    if (validUntilDate && !/^\d{4}-\d{2}-\d{2}$/.test(validUntilDate)) {
      return NextResponse.json({ error: 'Valid-until date is invalid.' }, { status: 400 })
    }
    if (validUntilDate && validUntilDate < validFromDate) {
      return NextResponse.json({ error: 'Valid-until date must be on or after valid-from.' }, { status: 400 })
    }
    if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      return NextResponse.json({ error: 'Max total uses must be a whole number of 1 or more, or left blank for unlimited.' }, { status: 400 })
    }
    if (!Number.isInteger(maxUsesPerUser) || maxUsesPerUser < 1) {
      return NextResponse.json({ error: 'Max uses per diner must be a whole number of 1 or more.' }, { status: 400 })
    }
    // 100%-off guard: not blocked outright, just requires the caller to have
    // explicitly acknowledged it — see the confirmation dialog in the form.
    if (discountType === 'percent' && discountValue >= 90 && body?.confirmHighDiscount !== true) {
      return NextResponse.json({ error: 'confirm_high_discount', requiresConfirmation: true }, { status: 409 })
    }

    // NO money_flow CHECK — removed 2026-10-04 per Peter's ruling (a restaurant-funded
    // code works if it is inside its start and end dates). Creation used to 409 on a
    // FAMILY_MEAL money_flow, which left a restaurant unable to create a code at one
    // location while the identical code worked at its sibling locations, purely
    // because the mirror of FamilyMeal's value had gone stale after conversion.
    // Leaving this in while the redemption gates come out would be the worse of both
    // worlds: the code would be allowed to redeem but not to exist.
    // Restaurant-LOCAL day boundaries, not UTC midnight — a bare date cast
    // straight to ::timestamptz is read as UTC, which cuts a US-timezone promo
    // off hours early (a restaurant setting "end Aug 31" got shut off at 8pm
    // local on Aug 30). See lib/timezone.ts for the fallback when a restaurant
    // has no timezone on file. Same conversion for every date field here — there's
    // only ever the two (valid_from/valid_until); none of the new fields are dates.
    // ALL OR NOTHING across the selected locations: if the code already exists at any of them, nothing is created and the
    // error names where. (There are no transactions on this connection, so the rows below go in ONE INSERT statement.)
    const clash = (await sql`
      SELECT COALESCE(c.name, p.restaurant_ref) AS name FROM promo_codes p
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = p.restaurant_ref
      WHERE p.restaurant_ref = ANY(${restaurantRefs}) AND UPPER(p.code) = ${code}
    `) as { name: string }[]
    if (clash.length) {
      return NextResponse.json({ error: `A promo code named ${code} already exists at ${clash.map((c) => c.name).join(', ')}. Nothing was created.` }, { status: 409 })
    }

    // One row per location: each keeps its own uses, limits and redemption rules, exactly as a one-location code does.
    // Rows created together share group_ref so the portal lists and edits them as one.
    const groupRef = restaurantRefs.length > 1 ? randomUUID() : null
    const vals: unknown[] = []
    const tuples: string[] = []
    for (const restaurantRef of restaurantRefs) {
      const { timezone } = await getRestaurantTimezone(restaurantRef)
      const validFrom = localDayBoundaryToUTC(validFromDate, timezone, false)
      const validUntil = validUntilDate ? localDayBoundaryToUTC(validUntilDate, timezone, true) : null
      const row = [code, discountType, discountValue, maxDiscountCap, minOrderSubtotal, firstTimeOnly, restaurantRef, maxUses, maxUsesPerUser,
        validFrom.toISOString(), validUntil ? validUntil.toISOString() : null, notes, groupRef]
      const p = row.map((v) => { vals.push(v); return `$${vals.length}` })
      tuples.push(`(${p[0]}, ${p[1]}, ${p[2]}, ${p[3]}, ${p[4]}, ${p[5]}, 'restaurant', ${p[6]}, 'RESTAURANT', ${p[7]}, ${p[8]}, ${p[9]}::timestamptz, ${p[10]}::timestamptz, ${p[11]}, ${p[12]}::uuid)`)
    }

    try {
      const rows = (await sql.query(
        `INSERT INTO promo_codes (
           code, discount_type, discount_value, max_discount_cap, min_order_subtotal, first_time_only,
           scope, restaurant_ref, funded_by, max_uses, max_uses_per_user, valid_from, valid_until, notes, group_ref
         ) VALUES ${tuples.join(', ')}
         RETURNING *`,
        vals,
      )) as Record<string, unknown>[]
      const created = rows.map(toApiCode)
      return NextResponse.json({ code: created[0], codes: created }, { status: 201 })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/unique|duplicate/i.test(msg)) {
        return NextResponse.json({ error: `A promo code named ${code} already exists at one of these locations. Nothing was created.` }, { status: 409 })
      }
      console.error('[restaurant/promo-codes] insert failed:', msg)
      return NextResponse.json({ error: 'Could not create promo code.' }, { status: 500 })
    }
  } catch (err) {
    console.error('[restaurant/promo-codes] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to create promo code' }, { status: 500 })
  }
}
