// Bulk-pricing apply (one item). SYSTEM_ADMIN only. Updates a single meal
// package's base price (+ optional display price) at a specific location.
//
// CRITICAL: FM's PUT /api/mealPackages/{ref} is a FULL-OBJECT REPLACE. We GET
// the current object, then rebuild the body to EXACTLY match the working
// menu-item editor (_MealPackageForm.tsx:254-296) — a curated FLAT payload —
// overriding only price + displayPrice. Raw-spreading the GET (which carries a
// scheduleOption{} block the editor never sends) returns 200 but FM silently
// DROPS displayPrice; the editor's curated shape persists it. Dates use the
// editor's flat ISO date-only fields (from/to/cutOffDate), extraItemsGroups is
// stripped to [{reference,enabled}], and image is reduced to {reference}.
//
// FM's single-package endpoint carries no restaurant ref, so it authorizes
// against the SYSTEM_ADMIN's CURRENT restaurant. We best-effort set that to the
// target location first (PUT /api/system-admin/restaurants/current) — the same
// call the location switcher uses — WITHOUT touching the selected-location
// cookie (the client re-syncs once at the end).

import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRole } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Date-only string from a possibly-datetime value, mirroring the editor's
// `d.from.split('T')[0]` (_MealPackageForm.tsx:197-198,211). FM's flat
// from/to/cutOffDate fields take ISO YYYY-MM-DD here (this is the shape the
// working editor sends — NOT scheduleOption/DD.MM.YYYY).
function dateOnly(v: unknown): string | undefined {
  if (v == null || v === '') return undefined
  return String(v).split('T')[0]
}
// Editor's daySelect default — all days true (_MealPackageForm.tsx:16,82-84).
const DAYS_OF_WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const allDaysTrue = Object.fromEntries(DAYS_OF_WEEK.map(d => [d, true]))

export async function POST(req: NextRequest) {
  const role = await getRestaurantRole()
  if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
    return NextResponse.json({ ok: false, error: 'System admin only' }, { status: 403 })
  }
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch { return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 }) }

  let body: { pkgRef?: string; restaurantRef?: string; price?: number | string; displayPrice?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'Bad request' }, { status: 400 }) }

  const { pkgRef, restaurantRef } = body
  if (!pkgRef || !restaurantRef) return NextResponse.json({ ok: false, error: 'pkgRef and restaurantRef required' }, { status: 400 })
  const priceNum = typeof body.price === 'number' ? body.price : parseFloat(String(body.price ?? ''))
  if (!isFinite(priceNum) || priceNum < 0) return NextResponse.json({ ok: false, error: 'Invalid price' }, { status: 400 })

  // 1. Scope FM to the target location (best-effort).
  try {
    await fetch(`${FM}/api/system-admin/restaurants/current?restaurantReference=${encodeURIComponent(restaurantRef)}`, { method: 'PUT', headers: h })
  } catch {}

  // 2. GET the full current object.
  const getRes = await fetch(`${FM}/api/mealPackages/${pkgRef}`, { headers: h })
  if (!getRes.ok) return NextResponse.json({ ok: false, error: `Could not load item (HTTP ${getRes.status})` })
  let obj: any
  try { obj = await getRes.json() } catch { return NextResponse.json({ ok: false, error: 'Could not parse item' }) }
  if (!obj || typeof obj !== 'object') return NextResponse.json({ ok: false, error: 'Empty item response' })

  // 3. Build the PUT body to EXACTLY match the working menu-item editor
  //    (_MealPackageForm.tsx:254-296) — a curated FLAT payload, NOT a raw
  //    re-send of the GET. Raw-spreading the GET (which includes a
  //    scheduleOption{} block) returns 200 but FM silently drops displayPrice;
  //    the editor's curated shape persists it. We source every field from the
  //    GET object and override only price + displayPrice.
  //
  //    displayPrice: new value when provided, else preserve the existing one
  //    (trimmed string, exactly as the editor sends it).
  const newDp = body.displayPrice
  const displayPriceOut = (typeof newDp === 'string' && newDp.trim() !== '')
    ? newDp.trim()
    : (obj.displayPrice != null && String(obj.displayPrice).trim() !== '' ? String(obj.displayPrice).trim() : undefined)

  // inherit gates daySelect exactly as the editor does (default true).
  const inherit = obj.inheritScheduleOptionFromRestaurant != null ? !!obj.inheritScheduleOptionFromRestaurant : true

  // IDENTICAL to _MealPackageForm.tsx:254-296 — same field names, same defaults
  // (editor ALWAYS sends the schedule fields with its state defaults when the
  // GET omits them), same transforms (trim, parseInt, date-only, hardcoded
  // available:true, daySelect only when !inherit). undefined keys are dropped by
  // JSON.stringify, matching the editor's `|| undefined`.
  const putBody: Record<string, unknown> = {
    name: String(obj.name ?? '').trim(),
    description: String(obj.description ?? '').trim(),
    type: obj.type ?? '',
    itemCategoryReference: obj.itemCategoryReference ?? obj.itemCategory?.reference ?? obj.category?.reference ?? obj.categoryReference,
    price: priceNum,
    displayPrice: displayPriceOut,
    serves: String(obj.serves ?? '').trim(),
    minQuantity: obj.minQuantity != null ? parseInt(String(obj.minQuantity), 10) : undefined,
    allowedSpecialInstructions: !!obj.allowedSpecialInstructions,
    vegetarian: !!obj.vegetarian,
    containsNuts: !!obj.containsNuts,
    glutenFree: !!obj.glutenFree,
    vegan: !!obj.vegan,
    containsAlcohol: !!obj.containsAlcohol,
    available: true,
    prepTime: obj.prepTime != null ? obj.prepTime : 0,
    prepDays: obj.prepDays != null ? obj.prepDays : 1,
    from: dateOnly(obj.from),
    to: dateOnly(obj.to),
    inventoryPerDay: obj.inventoryPerDay != null ? obj.inventoryPerDay : 100,
    maxOrder: obj.maxOrder != null ? obj.maxOrder : 100,
    isSameDay: obj.isSameDay != null ? !!obj.isSameDay : true,
    sameDaysTimeFrom: obj.sameDaysTimeFrom ?? '09',
    sameDaysMinutesFrom: obj.sameDaysMinutesFrom ?? '00',
    sameDaysMeridiemFrom: obj.sameDaysMeridiemFrom ?? 'AM',
    sameDaysTimeTo: obj.sameDaysTimeTo ?? '09',
    sameDaysMinutesTo: obj.sameDaysMinutesTo ?? '00',
    sameDaysMeridiemTo: obj.sameDaysMeridiemTo ?? 'PM',
    inheritScheduleOptionFromRestaurant: inherit,
    daySelect: inherit ? undefined : (obj.daySelect ?? allDaysTrue),
    extraItemsGroups: Array.isArray(obj.extraItemsGroups)
      ? obj.extraItemsGroups.map((g: any) => ({ reference: g.reference, enabled: g.enabled !== false }))
      : [],
  }
  // Cut-off — editor sends BY_DATE date-only OR DAILY time fields.
  if (obj.cutOffDate) putBody.cutOffDate = dateOnly(obj.cutOffDate)
  else if (obj.cutOffTimeFrom) {
    putBody.cutOffTimeFrom = obj.cutOffTimeFrom
    putBody.cutOffMinutesFrom = obj.cutOffMinutesFrom
    putBody.cutOffMeridiem = obj.cutOffMeridiem
  }
  if (obj.image && obj.image.reference) putBody.image = { reference: obj.image.reference }

  // 4. PUT the curated body.
  const putRes = await fetch(`${FM}/api/mealPackages/${pkgRef}`, {
    method: 'PUT',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  })
  const putText = await putRes.text().catch(() => '')
  // TEMPORARY diagnostic — surface FM's exact response so we can see the failure.
  console.log('[bulk apply-one] PUT body', JSON.stringify(putBody))
  console.log('[bulk apply-one] PUT result', JSON.stringify({ status: putRes.status, ok: putRes.ok, body: putText.slice(0, 800) }))
  if (!putRes.ok) {
    return NextResponse.json({ ok: false, error: `Update failed (HTTP ${putRes.status})${putText ? `: ${putText.slice(0, 140)}` : ''}` })
  }
  return NextResponse.json({ ok: true })
}
