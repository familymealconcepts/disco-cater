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

// FM's mealPackages PUT parses date fields as DD.MM.YYYY, but its GET hands them
// back as ISO YYYY-MM-DD — forwarding ISO verbatim 500s with a Java
// "Text '2025-11-01' could not be parsed". Convert a single value ISO →
// DD.MM.YYYY; pass through null/undefined and anything not a bare date.
function isoToDdMmYyyy(d?: string | null): string | null | undefined {
  if (d == null) return d
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).trim())
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d
}

// Deep-convert EVERY bare YYYY-MM-DD string anywhere in the object (top level,
// scheduleOption, repeatWeekDays, skippedDays, etc.) so no ISO date reaches FM's
// PUT regardless of where it nests. Datetimes ("…T…") and times ("HH:MM:SS")
// don't match the anchored date-only pattern, so they're left untouched.
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

  // 3. Merge ONLY price + displayPrice; preserve everything else. Fix the
  //    shapes FM's PUT needs that the GET returns differently: extraItemsGroups
  //    (rich → [{reference,enabled}]) and image (rich → {reference}).
  const merged: Record<string, unknown> = { ...obj, price: priceNum }
  const dp = body.displayPrice
  if (typeof dp === 'string' && dp.trim() !== '') merged.displayPrice = dp.trim()
  // (blank displayPrice → keep obj.displayPrice, already spread above)
  if (Array.isArray(obj.extraItemsGroups)) {
    merged.extraItemsGroups = obj.extraItemsGroups.map((g: any) => ({ reference: g.reference, enabled: g.enabled !== false }))
  }
  if (obj.image && obj.image.reference) merged.image = { reference: obj.image.reference }

  // Convert ALL ISO dates (anywhere in the body) to DD.MM.YYYY for FM's PUT.
  const putBody = convertDatesDeep(merged)

  // 4. PUT the merged full object.
  const putRes = await fetch(`${FM}/api/mealPackages/${pkgRef}`, {
    method: 'PUT',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  })
  if (!putRes.ok) {
    const putText = await putRes.text().catch(() => '')
    return NextResponse.json({ ok: false, error: `Update failed (HTTP ${putRes.status})${putText ? `: ${putText.slice(0, 140)}` : ''}` })
  }
  return NextResponse.json({ ok: true })
}
