import { NextRequest, NextResponse } from 'next/server'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Disco-native menu (Neon only — no FM call).
//   GET  ?restaurantRef=xxx → { categories: [...], items: [...] }
//   POST { restaurantReference, categoryName, name, description, price, serves }
//        → creates (upserting the category by name) and returns the new item

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const restaurantRef = (req.nextUrl.searchParams.get('restaurantRef') || '').trim()
  if (!UUID_RE.test(restaurantRef)) return NextResponse.json({ error: 'A valid restaurantRef is required.' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()
    const categories = (await sql`
      SELECT reference, restaurant_reference, name, description, position, visible, created_at, updated_at
      FROM disco_menu_categories
      WHERE restaurant_reference = ${restaurantRef}::uuid
      ORDER BY position, name
    `) as Record<string, unknown>[]
    const items = (await sql`
      SELECT reference, restaurant_reference, category_reference, name, description, price, serves,
             visible, position, image_url, created_at, updated_at
      FROM disco_menu_items
      WHERE restaurant_reference = ${restaurantRef}::uuid
      ORDER BY position, name
    `) as Record<string, unknown>[]
    return NextResponse.json({ categories, items })
  } catch (e) {
    console.error('[restaurant/menu] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load menu.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  const restaurantReference = String(body?.restaurantReference || '').trim()
  const categoryName = String(body?.categoryName || '').trim()
  const name = String(body?.name || '').trim()
  const description = body?.description != null ? String(body.description) : null
  const price = Number(body?.price)
  const serves = body?.serves != null ? String(body.serves) : null

  if (!UUID_RE.test(restaurantReference)) return NextResponse.json({ error: 'A valid restaurantReference is required.' }, { status: 400 })
  if (!name) return NextResponse.json({ error: 'name is required.' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()

    // Upsert the category by (menu_reference, name) → its reference. This route has
    // no menu concept of its own (test/E2E-fixture only — not used by any live
    // restaurant-portal or customer flow), so find-or-create a default menu to scope
    // the category to, matching disco_menu_categories' real UNIQUE (menu_reference, name).
    let categoryReference: string | null = null
    if (categoryName) {
      const existingMenu = (await sql`
        SELECT reference FROM disco_menus WHERE restaurant_reference = ${restaurantReference}::uuid
        ORDER BY position, created_at LIMIT 1
      `) as { reference: string }[]
      let menuReference = existingMenu[0]?.reference
      if (!menuReference) {
        const newMenu = (await sql`
          INSERT INTO disco_menus (restaurant_reference, name, url)
          VALUES (${restaurantReference}::uuid, 'Menu', 'menu')
          RETURNING reference
        `) as { reference: string }[]
        menuReference = newMenu[0].reference
      }
      const catRows = (await sql`
        INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name)
        VALUES (${restaurantReference}::uuid, ${menuReference}::uuid, ${categoryName})
        ON CONFLICT (menu_reference, name) DO UPDATE SET updated_at = NOW()
        RETURNING reference
      `) as { reference: string }[]
      categoryReference = catRows[0]?.reference ?? null
    }

    const itemRows = (await sql`
      INSERT INTO disco_menu_items (restaurant_reference, category_reference, name, description, price, serves)
      VALUES (${restaurantReference}::uuid, ${categoryReference}::uuid, ${name}, ${description},
              ${Number.isFinite(price) ? price : 0}, ${serves})
      RETURNING reference, restaurant_reference, category_reference, name, description, price, serves,
                visible, position, image_url, created_at, updated_at
    `) as Record<string, unknown>[]

    return NextResponse.json(itemRows[0], { status: 200 })
  } catch (e) {
    console.error('[restaurant/menu] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create menu item.' }, { status: 500 })
  }
}
