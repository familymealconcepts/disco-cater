// Bulk-pricing apply (one item). SYSTEM_ADMIN only. Updates a single meal
// package's base price (+ optional display price) at a specific location.
//
// CRITICAL: FM's PUT /api/mealPackages/{ref} is a FULL-OBJECT REPLACE. We GET
// the current object and PRESERVE it (including its real scheduleOption — real
// inventoryPerDay/maxOrder/prepTime/scheduleType/isRestaurantDefault), then
// override ONLY price + displayPrice. Rebuilding a curated flat payload with the
// editor's DEFAULT schedule values (100/100, inherit:true) conflicts with a
// custom-schedule item (isRestaurantDefault:false) → FM 500-001. We only fix the
// shapes FM's PUT needs differently from its GET: extraItemsGroups (rich →
// [{reference,enabled}]), image (rich → {reference}), scheduleOption dates (ISO →
// DD.MM.YYYY), and inherit = !scheduleOption.isRestaurantDefault.
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

// FM's PUT parses scheduleOption dates as DD.MM.YYYY but its GET returns ISO
// YYYY-MM-DD; forwarding ISO 500s ("Text '2025-11-01' could not be parsed").
function isoToDdMmYyyy(d?: string | null): string | null | undefined {
  if (d == null) return d
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).trim())
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d
}
// Deep-convert every bare YYYY-MM-DD string anywhere in the object. Datetimes
// ("…T…") and times ("HH:MM:SS") don't match, so they're left untouched.
function convertDatesDeep(v: any): any {
  if (typeof v === 'string') return isoToDdMmYyyy(v)
  if (Array.isArray(v)) return v.map(convertDatesDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = convertDatesDeep(v[k])
    return out
  }
  return v
}

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
  // TEMPORARY diagnostic — see the exact GET shape (type/itemType + any field
  // we might be omitting). Remove once bulk pricing is confirmed.
  console.log('[bulk apply-one] GET response', JSON.stringify(obj))

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

  // PRESERVE the full GET object (incl. its real scheduleOption: inventoryPerDay,
  // maxOrder, prepTime, scheduleType, isRestaurantDefault, dates, repeatWeekDays)
  // and override ONLY price + displayPrice. Rebuilding the schedule from editor
  // defaults (100/100, inherit:true) conflicts with a custom-schedule item
  // (isRestaurantDefault:false) → FM 500. We just fix the shapes FM's PUT needs
  // differently from its GET.
  const merged: Record<string, unknown> = { ...obj, price: priceNum }
  if (typeof newDp === 'string' && newDp.trim() !== '') merged.displayPrice = newDp.trim()
  // (blank → keep the existing displayPrice from the spread)

  // extraItemsGroups: rich → [{reference,enabled}]; image: rich → {reference}.
  if (Array.isArray(obj.extraItemsGroups)) {
    merged.extraItemsGroups = obj.extraItemsGroups.map((g: any) => ({ reference: g.reference, enabled: g.enabled !== false }))
  }
  if (obj.image && obj.image.reference) merged.image = { reference: obj.image.reference }

  // Keep inherit consistent with the item's real schedule: a custom schedule
  // (scheduleOption.isRestaurantDefault === false) MUST send inherit=false.
  if (obj.scheduleOption && typeof obj.scheduleOption === 'object' && obj.scheduleOption.isRestaurantDefault != null) {
    merged.inheritScheduleOptionFromRestaurant = !obj.scheduleOption.isRestaurantDefault
  }

  // ISO YYYY-MM-DD → DD.MM.YYYY everywhere (scheduleOption dates, etc.).
  const putBody = convertDatesDeep(merged)

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
