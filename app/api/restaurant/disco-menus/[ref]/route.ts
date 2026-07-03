import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MENU_TYPES = new Set([
  'GENERAL_CATERING', 'OFFICE_CATERING', 'HOLIDAY_CATERING', 'MEAL_PREP',
  'PRIVATE_CHEF', 'NATIONWIDE_SHIPPING', 'MERCH', 'POP_UP',
])
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
    SELECT reference, restaurant_reference, name, url, type, description, image_url,
           visible, archived, position, availability_mode,
           to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
           schedule_config, created_at, updated_at
    FROM disco_menus WHERE reference = ${ref}::uuid LIMIT 1
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
  const type = String(body?.type || 'GENERAL_CATERING')
  if (!MENU_TYPES.has(type)) return NextResponse.json({ error: 'Invalid menu category.' }, { status: 400 })

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
    await sql`
      UPDATE disco_menus SET
        name = ${name}, type = ${type}, url = ${url},
        description = ${String(body?.description || '') || null},
        image_url = COALESCE(${String(body?.imageUrl || '') || null}, image_url),
        visible = ${body?.visible === false ? false : true},
        availability_mode = ${availabilityMode},
        start_date = ${startDate}::date, end_date = ${endDate}::date,
        schedule_config = ${scheduleConfig}::jsonb,
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
