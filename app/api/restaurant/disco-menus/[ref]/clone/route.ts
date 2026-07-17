import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function slugify(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
}

// M1 — deep-clone a Disco-native menu into a new "… (Copy)" menu: copies the menu's
// settings + its categories + items + item→modifier-group links. The shared modifier
// LIBRARY (groups/modifiers) is re-linked, not duplicated. Scoped to the caller's
// restaurant; zero FM.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid menu reference' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()

    // Source menu must belong to the caller's restaurant.
    const src = (await sql`
      SELECT reference, name FROM disco_menus
      WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid AND archived = false
      LIMIT 1
    `) as { reference: string; name: string }[]
    if (!src.length) return NextResponse.json({ error: 'Menu not found' }, { status: 404 })

    // Unique name + url for the copy.
    const newName = `${src[0].name} (Copy)`.slice(0, 200)
    const base = slugify(newName) || 'menu-copy'
    let url = base
    const isTaken = async (u: string) => ((await sql`SELECT 1 FROM disco_menus WHERE restaurant_reference = ${scope}::uuid AND url = ${u} LIMIT 1`) as unknown[]).length > 0
    for (let i = 2; i < 100 && (await isTaken(url)); i++) url = `${base}-${i}`

    // 1) Copy the menu row (all settings columns), overriding identity/name/url/position.
    const menuRows = (await sql`
      INSERT INTO disco_menus (
        restaurant_reference, name, url, type, description, image_url, visible, archived, position,
        availability_mode, start_date, end_date, schedule_config,
        offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
        tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
        max_orders_per_day, lead_time_hours, rolling_availability_days, daily_cutoff_time, hard_cutoff_date,
        delivery_settings, skipped_days, include_utensils, created_at, updated_at
      )
      SELECT restaurant_reference, ${newName}, ${url}, type, description, image_url, visible, false,
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menus WHERE restaurant_reference = ${scope}::uuid),
        availability_mode, start_date, end_date, schedule_config,
        offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
        tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
        max_orders_per_day, lead_time_hours, rolling_availability_days, daily_cutoff_time, hard_cutoff_date,
        delivery_settings, skipped_days, include_utensils, NOW(), NOW()
      FROM disco_menus WHERE reference = ${ref}::uuid
      RETURNING reference
    `) as { reference: string }[]
    const newMenuRef = menuRows[0].reference

    // 2) Categories → map old category reference → new.
    const cats = (await sql`
      SELECT reference, name, description, position, visible
      FROM disco_menu_categories WHERE menu_reference = ${ref}::uuid ORDER BY position, name
    `) as Array<{ reference: string; name: string; description: string | null; position: number | null; visible: boolean | null }>
    const catMap = new Map<string, string>()
    // Category names are UNIQUE per (restaurant, name), so a same-restaurant clone
    // can't reuse the source names — disambiguate ("Platters" → "Platters (Copy)",
    // then " (Copy 2)"…). The restaurant can rename afterward.
    const catNameTaken = async (n: string) => ((await sql`SELECT 1 FROM disco_menu_categories WHERE restaurant_reference = ${scope}::uuid AND name = ${n} LIMIT 1`) as unknown[]).length > 0
    for (const c of cats) {
      let cname = `${c.name} (Copy)`.slice(0, 200)
      for (let i = 2; i < 100 && (await catNameTaken(cname)); i++) cname = `${c.name} (Copy ${i})`.slice(0, 200)
      const ins = (await sql`
        INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name, description, position, visible)
        VALUES (${scope}::uuid, ${newMenuRef}::uuid, ${cname}, ${c.description}, ${c.position ?? 0}, ${c.visible ?? true})
        RETURNING reference
      `) as { reference: string }[]
      catMap.set(c.reference, ins[0].reference)
    }

    // 3) Items (across the source categories) → map old item reference → new.
    const oldCatRefs = cats.map(c => c.reference)
    const itemMap = new Map<string, string>()
    let itemCount = 0
    if (oldCatRefs.length) {
      const items = (await sql`
        SELECT reference, category_reference, name, description, price, serves, visible, position,
               image_url, display_price, min_quantity, allow_special_instructions,
               vegetarian, contains_nuts, gluten_free, vegan
        FROM disco_menu_items WHERE category_reference = ANY(${oldCatRefs}) ORDER BY position, name
      `) as Array<Record<string, unknown>>
      for (const it of items) {
        const newCat = catMap.get(it.category_reference as string)
        if (!newCat) continue
        const ins = (await sql`
          INSERT INTO disco_menu_items (
            restaurant_reference, category_reference, name, description, price, serves, visible, position,
            image_url, display_price, min_quantity, allow_special_instructions,
            vegetarian, contains_nuts, gluten_free, vegan
          ) VALUES (
            ${scope}::uuid, ${newCat}::uuid, ${it.name}, ${it.description}, ${it.price}, ${it.serves}, ${it.visible ?? true}, ${it.position ?? 0},
            ${it.image_url}, ${it.display_price}, ${it.min_quantity}, ${it.allow_special_instructions ?? false},
            ${it.vegetarian ?? false}, ${it.contains_nuts ?? false}, ${it.gluten_free ?? false}, ${it.vegan ?? false}
          )
          RETURNING reference
        `) as { reference: string }[]
        itemMap.set(it.reference as string, ins[0].reference)
        itemCount++
      }
    }

    // 4) Item → modifier-group links (re-link to the SAME shared groups).
    const oldItemRefs = [...itemMap.keys()]
    let linkCount = 0
    if (oldItemRefs.length) {
      const links = (await sql`
        SELECT item_reference, group_reference, enabled, position
        FROM disco_item_groups WHERE item_reference = ANY(${oldItemRefs})
      `) as Array<{ item_reference: string; group_reference: string; enabled: boolean | null; position: number | null }>
      for (const l of links) {
        const newItem = itemMap.get(l.item_reference)
        if (!newItem) continue
        await sql`
          INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position)
          VALUES (${newItem}::uuid, ${l.group_reference}::uuid, ${l.enabled ?? true}, ${l.position ?? 0})
          ON CONFLICT (item_reference, group_reference) DO NOTHING
        `
        linkCount++
      }
    }

    return NextResponse.json({ reference: newMenuRef, url, categories: cats.length, items: itemCount, groupLinks: linkCount })
  } catch (e) {
    console.error('[restaurant/disco-menus/[ref]/clone] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to clone menu' }, { status: 500 })
  }
}
