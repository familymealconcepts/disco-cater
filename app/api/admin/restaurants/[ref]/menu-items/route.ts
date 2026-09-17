import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { parseItemFields } from '../../../../../../lib/menu-settings'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// A Disco-native restaurant's menu lives in disco_menu_items. Creating an item
// for one through FM's /api/mealPackages wrote it into a menu nothing serves:
// the item never appeared on Disco Cater, and the call still returned a
// reference, so it looked like it worked.
//
// FM's payload names a category by NAME (`category`), not by reference, so that
// is what is resolved here. An item must belong to a category — if the named one
// does not exist, or none is named and the restaurant has more than one, this
// REFUSES and lists the choices rather than guessing which menu section a new
// item belongs in.
async function createNativeMenuItem(ref: string, body: Record<string, unknown>) {
  const name = String(body?.name ?? '').trim()
  await runDiscoMenuMigrations()

  const cats = (await sql`
    SELECT reference::text AS reference, name
      FROM disco_menu_categories WHERE restaurant_reference = ${ref}::uuid ORDER BY position, id
  `.catch(() => [])) as Array<{ reference: string; name: string }>
  if (!cats.length) {
    return NextResponse.json({ error: 'This restaurant has no menu categories yet — create one before adding items.' }, { status: 409 })
  }

  const wanted = String(body?.category ?? '').trim().toLowerCase()
  let category = wanted ? cats.find(c => String(c.name || '').trim().toLowerCase() === wanted) : (cats.length === 1 ? cats[0] : undefined)
  if (!category) {
    return NextResponse.json({
      error: wanted
        ? `No menu category named "${body.category}" on this restaurant.`
        : 'category is required — this restaurant has more than one menu category.',
      categories: cats.map(c => c.name),
    }, { status: 400 })
  }

  const servesNum = parseInt(String(body?.serves ?? '').replace(/[^\d]/g, ''), 10)
  const f = parseItemFields(body)
  const price = Number(body?.price)
  try {
    const rows = (await sql`
      INSERT INTO disco_menu_items (
        restaurant_reference, category_reference, name, description, price, serves, visible,
        display_price, min_quantity, allow_special_instructions, vegetarian, contains_nuts, gluten_free, vegan,
        max_inventory_per_day, position)
      VALUES (${ref}::uuid, ${category.reference}::uuid, ${name},
              ${String(body?.description ?? '') || null}, ${Number.isFinite(price) ? price : 0},
              ${Number.isFinite(servesNum) && servesNum > 0 ? String(servesNum) : null}, true,
              ${f.displayPrice}, ${f.minQuantity}, ${f.allowSpecialInstructions}, ${f.vegetarian}, ${f.containsNuts}, ${f.glutenFree}, ${f.vegan},
              ${f.maxInventoryPerDay},
              (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menu_items WHERE category_reference = ${category.reference}::uuid))
      RETURNING reference::text AS reference
    `) as Array<{ reference: string }>
    // itemReference is the key the FM path returns; keep it identical so callers
    // need no branch of their own.
    return NextResponse.json({ itemReference: rows[0]?.reference, reference: rows[0]?.reference, native: true, category: category.name })
  } catch (e) {
    console.error('[admin/menu-items] native create failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create menu item' }, { status: 500 })
  }
}

// Create a single meal package (menu item) on a restaurant. Thin wrapper around
// FM POST /api/mealPackages with the SUPER_ADMIN admin JWT (raw, no Bearer).
//   POST /api/admin/restaurants/{ref}/menu-items
//   body: { name, price, serves, category?, description?, itemType? }
//   → { itemReference }
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let auth: Record<string, string>
  try { auth = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  const name = String(body?.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name is required.' }, { status: 400 })

  if (await isDiscoNativeRestaurant(ref)) return createNativeMenuItem(ref, body)

  const servesNum = parseInt(String(body?.serves ?? '').replace(/[^\d]/g, ''), 10)

  try {
    const res = await fetch(`${FM}/api/mealPackages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name,
        description: String(body?.description ?? ''),
        price: Number(body?.price) || 0,
        serves: Number.isFinite(servesNum) && servesNum > 0 ? servesNum : 1,
        itemType: body?.itemType === 'REGULAR' ? 'REGULAR' : 'CATERING',
        restaurantReference: ref,
        category: body?.category ? String(body.category) : undefined,
      }),
    })
    const text = await res.text()
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to create menu item', raw: text.slice(0, 300) }, { status: res.status })
    }
    let data: Record<string, unknown> = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* non-JSON */ }
    const itemReference = String(data?.reference || data?.mealPackageReference || '')
    return NextResponse.json({ itemReference, ...data })
  } catch (e) {
    console.error('[admin/menu-items] create failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create menu item' }, { status: 500 })
  }
}
