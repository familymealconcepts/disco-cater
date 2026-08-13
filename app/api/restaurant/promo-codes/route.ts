import { NextRequest, NextResponse } from 'next/server'
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

    // Target location: a SYSTEM_ADMIN MUST name an explicit in-scope location; an
    // ADMIN always uses their own. Codes never apply restaurant-wide by accident.
    let restaurantRef = scope.ownRef
    if (scope.isSystemAdmin) {
      restaurantRef = String(body?.restaurantReference || '').trim()
      if (!restaurantRef) return NextResponse.json({ error: 'Select a location for this promo code.' }, { status: 400 })
    }
    if (!UUID_RE.test(restaurantRef) || !isPromoRefAllowed(scope, restaurantRef)) {
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

    // Restaurant-funded codes are DIRECT-only (permanent). Under FAMILY_MEAL money-
    // flow, FM is the merchant of record and pays the restaurant out-of-band, so a
    // discount can't be made to come off the restaurant — it would hit FamilyMeal's
    // balance. Block creation for FAMILY_MEAL locations. (NULL money_flow = FM
    // default DIRECT → allowed.)
    const mfRows = (await sql`SELECT money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantRef} LIMIT 1`) as { money_flow: string | null }[]
    if (mfRows[0]?.money_flow === 'FAMILY_MEAL') {
      return NextResponse.json({ error: 'This location holds payments on FamilyMeal (money-flow), so restaurant-funded promo codes can’t settle here — the discount would come off FamilyMeal, not the restaurant. Not supported.' }, { status: 409 })
    }

    // Restaurant-LOCAL day boundaries, not UTC midnight — a bare date cast
    // straight to ::timestamptz is read as UTC, which cuts a US-timezone promo
    // off hours early (a restaurant setting "end Aug 31" got shut off at 8pm
    // local on Aug 30). See lib/timezone.ts for the fallback when a restaurant
    // has no timezone on file. Same conversion for every date field here — there's
    // only ever the two (valid_from/valid_until); none of the new fields are dates.
    const { timezone } = await getRestaurantTimezone(restaurantRef)
    const validFrom = localDayBoundaryToUTC(validFromDate, timezone, false)
    const validUntil = validUntilDate ? localDayBoundaryToUTC(validUntilDate, timezone, true) : null

    try {
      const rows = (await sql`
        INSERT INTO promo_codes (
          code, discount_type, discount_value, max_discount_cap, min_order_subtotal, first_time_only,
          scope, restaurant_ref, funded_by, max_uses, max_uses_per_user, valid_from, valid_until, notes
        ) VALUES (
          ${code}, ${discountType}, ${discountValue}, ${maxDiscountCap}, ${minOrderSubtotal}, ${firstTimeOnly},
          'restaurant', ${restaurantRef}, 'RESTAURANT', ${maxUses}, ${maxUsesPerUser},
          ${validFrom.toISOString()}::timestamptz, ${validUntil ? validUntil.toISOString() : null}::timestamptz, ${notes}
        )
        RETURNING *
      `) as Record<string, unknown>[]
      return NextResponse.json({ code: toApiCode(rows[0]) }, { status: 201 })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/unique|duplicate/i.test(msg)) {
        return NextResponse.json({ error: `A promo code named ${code} already exists for this location.` }, { status: 409 })
      }
      console.error('[restaurant/promo-codes] insert failed:', msg)
      return NextResponse.json({ error: 'Could not create promo code.' }, { status: 500 })
    }
  } catch (err) {
    console.error('[restaurant/promo-codes] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to create promo code' }, { status: 500 })
  }
}
