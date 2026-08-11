import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { parseMenuSettingsInput, parseDeliverySettings, parseSkippedDays } from '../../../../../lib/menu-settings'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Menu Category (the per-menu `type`) is dropped as a Disco concept — the column
// still exists, so we always store this fixed value; it's never chosen by the user.
const MENU_TYPE_DEFAULT = 'GENERAL_CATERING'
function slugify(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
}

// Ownership guard: the menu must belong to the restaurant the caller is currently
// scoped to (their home location, or a SA's selected + authorized location).
async function ownedRef(reqRef: string): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(reqRef)) return null
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const rows = (await sql`
    SELECT 1 FROM disco_menus WHERE reference = ${reqRef}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length ? scopeRef : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedRef(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rows = (await sql`
    SELECT m.reference, m.restaurant_reference, m.name, m.url, m.type, m.description, m.image_url,
           m.visible, m.archived, m.position, m.availability_mode,
           to_char(m.start_date,'YYYY-MM-DD') AS start_date, to_char(m.end_date,'YYYY-MM-DD') AS end_date,
           m.schedule_config,
           m.offers_pickup, m.offers_delivery, m.service_charge_pct, m.service_charge_name,
           m.tip_default_type, m.tip_default_value, m.pickup_order_minimum, m.delivery_order_minimum,
           m.max_orders_per_day, m.lead_time_hours, m.rolling_availability_days,
           to_char(m.daily_cutoff_time,'HH24:MI') AS daily_cutoff_time,
           to_char(m.hard_cutoff_date,'YYYY-MM-DD') AS hard_cutoff_date,
           m.delivery_settings, m.skipped_days, m.include_utensils, m.created_at, m.updated_at,
           c.slug AS restaurant_slug
    FROM disco_menus m
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text
    WHERE m.reference = ${ref}::uuid LIMIT 1
  `) as Record<string, unknown>[]
  return NextResponse.json({ menu: rows[0] || null })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  const restRef = await ownedRef(ref)
  if (!restRef) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  const name = String(body?.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'Menu name is required.' }, { status: 400 })
  const type = MENU_TYPE_DEFAULT

  // URL slug — uniqueness per restaurant (excluding self). A user-typed collision
  // is a hard 409; a blank/derived one is auto-suffixed.
  const urlAuto = body?.urlAuto !== false
  const base = slugify(String(body?.url || '') || name) || 'menu'
  let url = base
  const takenByOther = async (u: string) => ((await sql`
    SELECT 1 FROM disco_menus WHERE restaurant_reference = ${restRef}::uuid AND url = ${u} AND reference <> ${ref}::uuid LIMIT 1
  `) as unknown[]).length > 0
  if (!urlAuto) {
    if (await takenByOther(url)) return NextResponse.json({ error: 'That URL is already taken. Choose another.' }, { status: 409 })
  } else {
    for (let i = 2; i < 50 && (await takenByOther(url)); i++) url = `${base}-${i}`
  }

  const availabilityMode = String(body?.availabilityMode || 'ALWAYS') === 'CUSTOM' ? 'CUSTOM' : 'ALWAYS'
  const startDate = availabilityMode === 'CUSTOM' && body?.startDate ? String(body.startDate) : null
  const endDate = availabilityMode === 'CUSTOM' && body?.endDate ? String(body.endDate) : null
  const scheduleConfig = body?.scheduleConfig != null ? JSON.stringify(body.scheduleConfig) : null

  try {
    const s = parseMenuSettingsInput(body)
    await sql`
      UPDATE disco_menus SET
        name = ${name}, type = ${type}, url = ${url},
        description = ${String(body?.description || '') || null},
        image_url = COALESCE(${String(body?.imageUrl || '') || null}, image_url),
        visible = ${body?.visible === false ? false : true},
        availability_mode = ${availabilityMode},
        start_date = ${startDate}::date, end_date = ${endDate}::date,
        schedule_config = ${scheduleConfig}::jsonb,
        offers_pickup = ${s.offersPickup}, offers_delivery = ${s.offersDelivery},
        service_charge_pct = ${s.serviceChargePct}, service_charge_name = ${s.serviceChargeName},
        tip_default_type = ${s.tipDefaultType}, tip_default_value = ${s.tipDefaultValue},
        pickup_order_minimum = ${s.pickupOrderMinimum}, delivery_order_minimum = ${s.deliveryOrderMinimum},
        max_orders_per_day = ${s.maxOrdersPerDay}, lead_time_hours = ${s.leadTimeHours},
        rolling_availability_days = ${s.rollingAvailabilityDays},
        daily_cutoff_time = ${s.dailyCutoffTime}::time, hard_cutoff_date = ${s.hardCutoffDate}::date,
        delivery_settings = ${JSON.stringify(parseDeliverySettings(body))}::jsonb,
        skipped_days = ${JSON.stringify(parseSkippedDays(body))}::jsonb,
        include_utensils = ${s.includeUtensils},
        updated_at = NOW()
      WHERE reference = ${ref}::uuid
    `
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[restaurant/disco-menus/[ref]] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update menu' }, { status: 500 })
  }
}

// Soft-delete (archive) — mirrors FM's archived flag; keeps categories/items.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedRef(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    await sql`UPDATE disco_menus SET archived = true, updated_at = NOW() WHERE reference = ${ref}::uuid`
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[restaurant/disco-menus/[ref]] DELETE failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to delete menu' }, { status: 500 })
  }
}
