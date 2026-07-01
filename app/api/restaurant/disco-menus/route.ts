import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Disco-native MENU records (Neon source of truth). FM parity: a restaurant has
// many menus; each menu owns categories → items. FM is reference only.
//   GET  → list this restaurant's menus (ordered by position)
//   POST → create a menu { name, type, url?, description?, imageUrl?, visible?,
//          availabilityMode, startDate?, endDate?, scheduleConfig }

const MENU_TYPES = new Set([
  'GENERAL_CATERING', 'OFFICE_CATERING', 'HOLIDAY_CATERING', 'MEAL_PREP',
  'PRIVATE_CHEF', 'NATIONWIDE_SHIPPING', 'MERCH', 'POP_UP',
])

// FM slug rule: lowercase letters/numbers/hyphens only (^[a-z0-9-]+$).
function slugify(s: string): string {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
}

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = ctx.restaurantReference
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  try {
    await runDiscoMenuMigrations()
    const menus = (await sql`
      SELECT reference, restaurant_reference, name, url, type, description, image_url,
             visible, archived, position, availability_mode,
             to_char(start_date,'YYYY-MM-DD') AS start_date,
             to_char(end_date,'YYYY-MM-DD') AS end_date,
             schedule_config, created_at, updated_at
      FROM disco_menus
      WHERE restaurant_reference = ${ref}::uuid AND archived = false
      ORDER BY position, name
    `) as Record<string, unknown>[]
    return NextResponse.json({ menus })
  } catch (e) {
    console.error('[restaurant/disco-menus] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load menus' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = ctx.restaurantReference
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  const name = String(body?.name || '').trim()
  if (!name) return NextResponse.json({ error: 'Menu name is required.' }, { status: 400 })
  const type = String(body?.type || 'GENERAL_CATERING')
  if (!MENU_TYPES.has(type)) return NextResponse.json({ error: 'Invalid menu category.' }, { status: 400 })

  // Slug: use the provided url (sanitized) or derive from name; ensure uniqueness
  // per restaurant by appending -2, -3, … on collision.
  const base = slugify(String(body?.url || '') || name) || 'menu'
  let url = base
  try {
    await runDiscoMenuMigrations()
    for (let i = 2; i < 50; i++) {
      const clash = (await sql`
        SELECT 1 FROM disco_menus WHERE restaurant_reference = ${ref}::uuid AND url = ${url} LIMIT 1
      `) as unknown[]
      if (clash.length === 0) break
      url = `${base}-${i}`
    }

    const availabilityMode = String(body?.availabilityMode || 'ALWAYS') === 'CUSTOM' ? 'CUSTOM' : 'ALWAYS'
    const startDate = availabilityMode === 'CUSTOM' && body?.startDate ? String(body.startDate) : null
    const endDate = availabilityMode === 'CUSTOM' && body?.endDate ? String(body.endDate) : null
    const scheduleConfig = body?.scheduleConfig != null ? JSON.stringify(body.scheduleConfig) : null

    const rows = (await sql`
      INSERT INTO disco_menus (
        restaurant_reference, name, url, type, description, image_url, visible,
        availability_mode, start_date, end_date, schedule_config,
        position, created_at, updated_at
      ) VALUES (
        ${ref}::uuid, ${name}, ${url}, ${type}, ${String(body?.description || '') || null},
        ${String(body?.imageUrl || '') || null}, ${body?.visible === false ? false : true},
        ${availabilityMode}, ${startDate}::date, ${endDate}::date, ${scheduleConfig}::jsonb,
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
