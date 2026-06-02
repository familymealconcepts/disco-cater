// Bulk-pricing apply (one item). SYSTEM_ADMIN only. Updates a single meal
// package's base price (+ optional display price) at a specific location.
//
// CRITICAL: FM's PUT /api/mealPackages/{ref} is a FULL-OBJECT REPLACE — sending
// a partial body wipes name/description/serves/schedule/modifiers (the same
// class of bug as the groups-archive). So we GET the full object, merge ONLY
// price + displayPrice, and PUT it back. extraItemsGroups comes back from the
// GET as rich objects but the PUT wants [{reference, enabled}] (mirrors the
// menu-item editor, _MealPackageForm.tsx:217-218,285) — and image is reduced to
// {reference} like the editor does. Everything else is preserved verbatim.
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

  // ── DIAGNOSTIC LOGGING (Vercel logs) — temporary, to find the PUT failure.
  console.log('[bulk apply-one] START', JSON.stringify({ pkgRef, restaurantRef, priceNum, displayPrice: body.displayPrice }))

  // 1. Scope FM to the target location (best-effort).
  let curStatus = 'n/a'
  try {
    const curRes = await fetch(`${FM}/api/system-admin/restaurants/current?restaurantReference=${encodeURIComponent(restaurantRef)}`, { method: 'PUT', headers: h })
    curStatus = String(curRes.status)
  } catch (e: any) { curStatus = `threw: ${e?.message || e}` }
  console.log('[bulk apply-one] setCurrentRestaurant →', JSON.stringify({ restaurantRef, status: curStatus }))

  // 2. GET the full current object.
  const getRes = await fetch(`${FM}/api/mealPackages/${pkgRef}`, { headers: h })
  if (!getRes.ok) {
    const gt = await getRes.text().catch(() => '')
    console.log('[bulk apply-one] GET FAILED', JSON.stringify({ pkgRef, status: getRes.status, body: gt.slice(0, 500) }))
    return NextResponse.json({ ok: false, error: `Could not load item (HTTP ${getRes.status})` })
  }
  let obj: any
  try { obj = await getRes.json() } catch { return NextResponse.json({ ok: false, error: 'Could not parse item' }) }
  if (!obj || typeof obj !== 'object') return NextResponse.json({ ok: false, error: 'Empty item response' })
  console.log('[bulk apply-one] GET response', JSON.stringify(obj))

  // 3. Merge ONLY price + displayPrice; preserve everything else. Fix the two
  //    shapes the editor normalizes (extraItemsGroups, image).
  const merged: Record<string, unknown> = { ...obj, price: priceNum }
  const dp = body.displayPrice
  if (typeof dp === 'string' && dp.trim() !== '') merged.displayPrice = dp.trim()
  // (blank displayPrice → keep obj.displayPrice, already spread above)
  if (Array.isArray(obj.extraItemsGroups)) {
    merged.extraItemsGroups = obj.extraItemsGroups.map((g: any) => ({ reference: g.reference, enabled: g.enabled !== false }))
  }
  if (obj.image && obj.image.reference) merged.image = { reference: obj.image.reference }
  console.log('[bulk apply-one] PUT body', JSON.stringify(merged))

  // 4. PUT the merged full object.
  const putRes = await fetch(`${FM}/api/mealPackages/${pkgRef}`, {
    method: 'PUT',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify(merged),
  })
  const putText = await putRes.text().catch(() => '')
  console.log('[bulk apply-one] PUT result', JSON.stringify({ status: putRes.status, ok: putRes.ok, body: putText.slice(0, 800) }))
  if (!putRes.ok) {
    return NextResponse.json({ ok: false, error: `Update failed (HTTP ${putRes.status})${putText ? `: ${putText.slice(0, 140)}` : ''}` })
  }
  return NextResponse.json({ ok: true })
}
