import { NextRequest, NextResponse } from 'next/server'
import { MENU_ACTIVE_SQL, MENU_INACTIVE_SQL, MENU_ARCHIVED_SQL, menuStateSql, menuTabOrderSql, type MenuState } from '../../../../lib/menu-state'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
import { parseMenuSettingsInput, parseDeliverySettings, parseSkippedDays } from '../../../../lib/menu-settings'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Disco-native MENU records (Neon source of truth). FM parity: a restaurant has
// many menus; each menu owns categories → items. FM is reference only.
//   GET  → list this restaurant's menus (ordered by position)
//   POST → create a menu { name, type, url?, description?, imageUrl?, visible?,
//          availabilityMode, startDate?, endDate?, scheduleConfig }

// Menu Category (the per-menu `type`) is dropped as a Disco concept — the column
// still exists, so we always store this fixed value; it's never chosen by the user.
const MENU_TYPE_DEFAULT = 'GENERAL_CATERING'

// FM slug rule: lowercase letters/numbers/hyphens only (^[a-z0-9-]+$).
function slugify(s: string): string {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
}

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  // Scope to the SA's selected location when applicable (else home). See
  // resolveDiscoScopeRef — fail-safe to home.
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  // ?tab=active|inactive|archived — the three states FM derives from the same two
  // booleans (see lib/menu-state.ts). Defaults to active, so a caller that sends
  // nothing gets the customer-facing set, which is the safe default.
  //
  // ?includeArchived=1 is still honoured for backwards compatibility: it maps to
  // "everything", which is what the old checkbox meant. Nothing in this repo
  // sends it any more, but a stale open tab might.
  const tabParam = String(req.nextUrl.searchParams.get('tab') || '').toLowerCase()
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1'
  const tab: MenuState | 'all' = tabParam === 'inactive' ? 'inactive'
    : tabParam === 'archived' ? 'archived'
    : tabParam === 'active' ? 'active'
    : includeArchived ? 'all' : 'active'
  try {
    await runDiscoMenuMigrations()
    // item_count: items belong to a category, categories belong to a menu — no
    // direct menu_reference on disco_menu_items, so count via that join.
    const menus = (await sql`
      SELECT m.reference, m.restaurant_reference, m.name, m.url, m.type, m.description, m.image_url,
             m.visible, m.archived, m.position, m.availability_mode,
             to_char(m.start_date,'YYYY-MM-DD') AS start_date,
             to_char(m.end_date,'YYYY-MM-DD') AS end_date,
             m.schedule_config, m.created_at, m.updated_at,
             COALESCE(ic.item_count, 0) AS item_count
      FROM disco_menus m
      LEFT JOIN (
        SELECT c.menu_reference, COUNT(i.id) AS item_count
        FROM disco_menu_categories c
        JOIN disco_menu_items i ON i.category_reference = c.reference
        GROUP BY c.menu_reference
      ) ic ON ic.menu_reference = m.reference
      WHERE m.restaurant_reference = ${ref}::uuid
        AND ${sql.unsafe(tab === 'all' ? 'TRUE' : menuStateSql(tab, 'm'))}
      ORDER BY ${sql.unsafe(tab === 'all' ? 'm.position, m.name' : menuTabOrderSql(tab, 'm'))}
    `) as Record<string, unknown>[]

    // Counts for ALL THREE tabs on every request, so an empty tab renders as a
    // real zero rather than looking broken. One extra round-trip, computed with
    // the same predicates the tabs filter on — deriving them from the returned
    // rows would only ever describe the tab you are already looking at.
    const countRows = (await sql`
      SELECT
        COUNT(*) FILTER (WHERE ${sql.unsafe(MENU_ACTIVE_SQL)})   AS active,
        COUNT(*) FILTER (WHERE ${sql.unsafe(MENU_INACTIVE_SQL)}) AS inactive,
        COUNT(*) FILTER (WHERE ${sql.unsafe(MENU_ARCHIVED_SQL)}) AS archived
      FROM disco_menus WHERE restaurant_reference = ${ref}::uuid
    `) as { active: string; inactive: string; archived: string }[]
    const counts = {
      active: Number(countRows[0]?.active ?? 0),
      inactive: Number(countRows[0]?.inactive ?? 0),
      archived: Number(countRows[0]?.archived ?? 0),
    }
    return NextResponse.json({ restaurant_reference: ref, tab, counts, menus })
  } catch (e) {
    console.error('[restaurant/disco-menus] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load menus' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  // Create under the restaurant_reference the CLIENT explicitly claims (the one
  // its form was loaded for), verified against the caller's permitted set —
  // never whatever the session's current selection resolves to. A stale
  // selection must never misfile a brand-new menu under the wrong restaurant.
  const check = await requireWritableRestaurantRef(body?.restaurant_reference)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref

  const name = String(body?.name || '').trim()
  if (!name) return NextResponse.json({ error: 'Menu name is required.' }, { status: 400 })
  const type = MENU_TYPE_DEFAULT

  // Slug: derived from name (urlAuto) → append -2,-3… on collision silently.
  // User-typed slug (urlAuto=false) → a collision is a hard 409 with a clear
  // message so the form can show inline "that URL is taken".
  const urlAuto = body?.urlAuto !== false
  const base = slugify(String(body?.url || '') || name) || 'menu'
  let url = base
  try {
    await runDiscoMenuMigrations()
    const isTaken = async (u: string) => ((await sql`
      SELECT 1 FROM disco_menus WHERE restaurant_reference = ${ref}::uuid AND url = ${u} LIMIT 1
    `) as unknown[]).length > 0
    if (!urlAuto) {
      if (await isTaken(url)) return NextResponse.json({ error: 'That URL is already taken. Choose another.' }, { status: 409 })
    } else {
      for (let i = 2; i < 50 && (await isTaken(url)); i++) url = `${base}-${i}`
    }

    const availabilityMode = String(body?.availabilityMode || 'ALWAYS') === 'CUSTOM' ? 'CUSTOM' : 'ALWAYS'
    const startDate = availabilityMode === 'CUSTOM' && body?.startDate ? String(body.startDate) : null
    const endDate = availabilityMode === 'CUSTOM' && body?.endDate ? String(body.endDate) : null
    const scheduleConfig = body?.scheduleConfig != null ? JSON.stringify(body.scheduleConfig) : null
    const s = parseMenuSettingsInput(body)

    const rows = (await sql`
      INSERT INTO disco_menus (
        restaurant_reference, name, url, type, description, image_url, visible,
        availability_mode, start_date, end_date, schedule_config,
        offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
        tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
        max_orders_per_day, lead_time_hours, rolling_availability_days, daily_cutoff_time, hard_cutoff_date,
        delivery_settings, skipped_days, include_utensils, position, created_at, updated_at
      ) VALUES (
        ${ref}::uuid, ${name}, ${url}, ${type}, ${String(body?.description || '') || null},
        ${String(body?.imageUrl || '') || null}, ${body?.visible === false ? false : true},
        ${availabilityMode}, ${startDate}::date, ${endDate}::date, ${scheduleConfig}::jsonb,
        ${s.offersPickup}, ${s.offersDelivery}, ${s.serviceChargePct}, ${s.serviceChargeName},
        ${s.tipDefaultType}, ${s.tipDefaultValue}, ${s.pickupOrderMinimum}, ${s.deliveryOrderMinimum},
        ${s.maxOrdersPerDay}, ${s.leadTimeHours}, ${s.rollingAvailabilityDays}, ${s.dailyCutoffTime}::time, ${s.hardCutoffDate}::date,
        ${JSON.stringify(parseDeliverySettings(body))}::jsonb, ${JSON.stringify(parseSkippedDays(body))}::jsonb, ${s.includeUtensils},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menus WHERE restaurant_reference = ${ref}::uuid),
        NOW(), NOW()
      )
      RETURNING reference
    `) as { reference: string }[]
    return NextResponse.json({ reference: rows[0]?.reference, url })
  } catch (e) {
    console.error('[restaurant/disco-menus] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create menu' }, { status: 500 })
  }
}
