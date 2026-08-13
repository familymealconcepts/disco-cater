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
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../../lib/disco-restaurant-auth'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ApplyBody { pkgRef?: string; restaurantRef?: string; price?: number | string; displayPrice?: string | null; newName?: string; newDescription?: string; newServes?: string }

// Disco-native apply: update one disco_menu_items row's price (+ optional display
// price / name / description / serves) at a location in the SA's group. Zero FM.
// Mirrors the FM path's field semantics: name set only when non-empty; display
// price set only when non-empty (blank preserves); description/serves may clear.
async function nativeApply(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, body: ApplyBody) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ ok: false, error: 'System admin only' }, { status: 403 })
  }
  const { pkgRef, restaurantRef } = body
  if (!pkgRef || !restaurantRef) return NextResponse.json({ ok: false, error: 'pkgRef and restaurantRef required' }, { status: 400 })
  const priceNum = typeof body.price === 'number' ? body.price : parseFloat(String(body.price ?? ''))
  if (!isFinite(priceNum) || priceNum < 0) return NextResponse.json({ ok: false, error: 'Invalid price' }, { status: 400 })

  // The target location must be inside the SA's own group (never trust the client).
  const allowed = new Set<string>([ctx.restaurantReference])
  try { for (const g of await getDiscoGroupAccounts(ctx.businessName, ctx.email)) allowed.add(g.restaurant_reference) } catch { /* home only */ }
  if (!allowed.has(restaurantRef)) return NextResponse.json({ ok: false, error: 'Location not in your group' }, { status: 403 })

  await runDiscoMenuMigrations()
  const cur = (await sql`
    SELECT name, description, price, display_price, serves FROM disco_menu_items
    WHERE reference = ${pkgRef}::uuid AND restaurant_reference::text = ${restaurantRef} LIMIT 1
  `) as { name: string; description: string | null; price: string | number; display_price: string | null; serves: string | null }[]
  if (!cur.length) return NextResponse.json({ ok: false, error: 'Item not found at that location' }, { status: 404 })
  const c = cur[0]

  const name = typeof body.newName === 'string' && body.newName.trim() !== '' ? body.newName.trim() : c.name
  const description = typeof body.newDescription === 'string' ? (body.newDescription.trim() || null) : c.description
  const serves = typeof body.newServes === 'string' ? (body.newServes.trim() || null) : c.serves
  const displayPrice = typeof body.displayPrice === 'string' && body.displayPrice.trim() !== '' ? body.displayPrice.trim() : c.display_price

  await sql`
    UPDATE disco_menu_items SET
      price = ${priceNum}, display_price = ${displayPrice}, name = ${name}, description = ${description}, serves = ${serves}, updated_at = NOW()
    WHERE reference = ${pkgRef}::uuid AND restaurant_reference::text = ${restaurantRef}
  `
  return NextResponse.json({ ok: true })
}

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
  let body: {
    pkgRef?: string; restaurantRef?: string; price?: number | string; displayPrice?: string | null
    // Optional bulk-editable text fields. The client only sends a field when it
    // actually changed (smart change detection), so an absent field here means
    // "preserve the existing value". newName is guarded against empty so a blank
    // input never wipes the item name; description/serves may be cleared.
    newName?: string; newDescription?: string; newServes?: string
  }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'Bad request' }, { status: 400 }) }

  // Disco-native SYSTEM_ADMINs write to Neon — never touch FM.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return nativeApply(ctx, body)

  const role = await getRestaurantRole()
  if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
    return NextResponse.json({ ok: false, error: 'System admin only' }, { status: 403 })
  }
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch { return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 }) }

  const { pkgRef, restaurantRef } = body
  if (!pkgRef || !restaurantRef) return NextResponse.json({ ok: false, error: 'pkgRef and restaurantRef required' }, { status: 400 })
  const priceNum = typeof body.price === 'number' ? body.price : parseFloat(String(body.price ?? ''))
  if (!isFinite(priceNum) || priceNum < 0) return NextResponse.json({ ok: false, error: 'Invalid price' }, { status: 400 })

  // DEFERRED RISK (FM-session only, not fixed): `restaurantRef` here is a raw
  // client-supplied value with NO membership check against this caller's FM
  // locations before being used to move FM's own "current restaurant" pointer
  // below — unlike every other FM switch, this one bypasses the validated
  // /api/restaurant/selected-restaurant route entirely and calls FM directly.
  // If FM's own backend doesn't independently enforce that this SYSTEM_ADMIN/
  // SUPER_ADMIN actually manages restaurantRef (unconfirmed), this is the same
  // cross-tenant vulnerability class Steps 1-3 closed, reachable through an
  // unaudited route, and it would let the caller write a price change (step 4
  // below) to a restaurant outside their own scope. Deliberately deferred:
  // all restaurants convert to disco-native within weeks and admins move to
  // the Disco Cater portal, so FM-session code paths here have a short shelf
  // life and are not worth hardening now. Also leaves FM's global "current
  // restaurant" pointer moved for the DURATION of a bulk-pricing batch (the
  // frontend restores it once at the end, not per-item, not in a try/finally
  // — see BulkPricingClient.tsx's apply()) — a live correctness issue for any
  // OTHER FM-session request that races this pointer mid-batch, separate
  // from the security question above.
  //
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

  // PRESERVE the full GET object (incl. its real scheduleOption: inventoryPerDay,
  // maxOrder, prepTime, scheduleType, isRestaurantDefault, dates, repeatWeekDays)
  // and override ONLY price + displayPrice. Rebuilding the schedule from editor
  // defaults (100/100, inherit:true) conflicts with a custom-schedule item
  // (isRestaurantDefault:false) → FM 500. We just fix the shapes FM's PUT needs
  // differently from its GET.
  const merged: Record<string, unknown> = { ...obj, price: priceNum }
  if (typeof newDp === 'string' && newDp.trim() !== '') merged.displayPrice = newDp.trim()
  // (blank → keep the existing displayPrice from the spread)

  // Bulk text overrides. Only present when the client detected a change, so each
  // is applied over the preserved GET value. name is guarded against empty (a
  // blank input must never erase the item name); description and serves may be
  // intentionally cleared.
  if (typeof body.newName === 'string' && body.newName.trim() !== '') merged.name = body.newName.trim()
  if (typeof body.newDescription === 'string') merged.description = body.newDescription.trim()
  if (typeof body.newServes === 'string') merged.serves = body.newServes.trim()

  // extraItemsGroups: rich → [{reference,enabled}]; image: rich → {reference}.
  if (Array.isArray(obj.extraItemsGroups)) {
    merged.extraItemsGroups = obj.extraItemsGroups.map((g: any) => ({ reference: g.reference, enabled: g.enabled !== false }))
  }
  if (obj.image && obj.image.reference) merged.image = { reference: obj.image.reference }

  // Category: the GET nests it as `itemCategory: {reference, name, …}` but the
  // PUT wants the flat `itemCategoryReference` string (sending the nested object
  // → FM 404-034 "Item category not found").
  if (obj.itemCategory?.reference) merged.itemCategoryReference = obj.itemCategory.reference
  delete merged.itemCategory

  // inherit MUST track the real schedule: isRestaurantDefault === true means the
  // item uses the restaurant default (inherit), false means a custom schedule.
  if (obj.scheduleOption && typeof obj.scheduleOption === 'object' && obj.scheduleOption.isRestaurantDefault != null) {
    merged.inheritScheduleOptionFromRestaurant = !!obj.scheduleOption.isRestaurantDefault
  }

  // ISO YYYY-MM-DD → DD.MM.YYYY everywhere (scheduleOption dates, etc.).
  const putBody = convertDatesDeep(merged)

  // 4. PUT the curated body.
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
