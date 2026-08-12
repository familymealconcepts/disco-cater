import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { sql, runMigrations } from '../../../../lib/db'
import { resolvePromoScope } from '../../../../lib/restaurant-promo'
import { getRestaurantTimezone, localDayBoundaryToUTC } from '../../../../lib/timezone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Map a promo_codes row to the restaurant-portal shape (percent discount, plain
// date strings, remaining-uses count).
function toApiCode(r: Record<string, unknown>) {
  const maxUses = r.max_uses == null ? null : Number(r.max_uses)
  const uses = Number(r.uses_count || 0)
  const isoDay = (v: unknown) => (v ? String(v).slice(0, 10) : '')
  return {
    id: Number(r.id),
    code: String(r.code),
    discountPercentage: Number(r.discount_value),
    startDate: isoDay(r.valid_from),
    endDate: isoDay(r.valid_until),
    maxAvailable: maxUses,
    remainingAvailable: maxUses == null ? null : Math.max(0, maxUses - uses),
    maxPerDiner: Number(r.max_uses_per_user || 1),
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
    if (focus && scope.allowedRefs.includes(focus)) refs = [focus]

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
    if (!UUID_RE.test(restaurantRef) || !scope.allowedRefs.includes(restaurantRef)) {
      return NextResponse.json({ error: 'You don’t have access to that location.' }, { status: 403 })
    }

    const code = String(body?.code || '').trim().toUpperCase()
    const discountPercentage = Number(body?.discountPercentage)
    const maxAvailable = Math.trunc(Number(body?.maxAvailable))
    const maxPerDiner = body?.maxPerDiner != null && body.maxPerDiner !== '' ? Math.trunc(Number(body.maxPerDiner)) : 1
    const startDate = String(body?.startDate || '').trim()
    const endDate = String(body?.endDate || '').trim()

    if (!code || !/^[A-Z0-9]+$/.test(code)) {
      return NextResponse.json({ error: 'Code must be uppercase letters and numbers only.' }, { status: 400 })
    }
    if (!Number.isFinite(discountPercentage) || discountPercentage < 1 || discountPercentage > 100) {
      return NextResponse.json({ error: 'Discount must be a number between 1 and 100.' }, { status: 400 })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return NextResponse.json({ error: 'Start and end dates are required.' }, { status: 400 })
    }
    if (endDate < startDate) {
      return NextResponse.json({ error: 'End date must be on or after the start date.' }, { status: 400 })
    }
    if (!Number.isFinite(maxAvailable) || maxAvailable < 1) {
      return NextResponse.json({ error: 'Max available must be a whole number of 1 or more.' }, { status: 400 })
    }
    if (!Number.isFinite(maxPerDiner) || maxPerDiner < 1) {
      return NextResponse.json({ error: 'Max per diner must be a whole number of 1 or more.' }, { status: 400 })
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
    // has no timezone on file.
    const { timezone } = await getRestaurantTimezone(restaurantRef)
    const validFrom = localDayBoundaryToUTC(startDate, timezone, false)
    const validUntil = localDayBoundaryToUTC(endDate, timezone, true)

    try {
      const rows = (await sql`
        INSERT INTO promo_codes (
          code, discount_type, discount_value, scope, restaurant_ref, funded_by,
          max_uses, max_uses_per_user, valid_from, valid_until
        ) VALUES (
          ${code}, 'percent', ${discountPercentage}, 'restaurant', ${restaurantRef}, 'RESTAURANT',
          ${maxAvailable}, ${maxPerDiner}, ${validFrom.toISOString()}::timestamptz, ${validUntil.toISOString()}::timestamptz
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
