import { randomUUID } from 'crypto'
import { sql } from '../db'

// Deep-copy a Disco-native restaurant's entire menu tree from sourceRef to newRef,
// regenerating every reference and remapping the foreign keys (menus → categories →
// items; modifiers + groups + memberships + item attachments; closed days). Used by
// the Locations "clone" action so a sister location starts with the same menu.
export async function cloneDiscoRestaurantMenus(sourceRef: string, newRef: string): Promise<void> {
  // 1. Menus
  const menus = (await sql`SELECT * FROM disco_menus WHERE restaurant_reference = ${sourceRef}::uuid`) as Record<string, unknown>[]
  const menuMap = new Map<string, string>()
  for (const m of menus) {
    const nr = randomUUID(); menuMap.set(m.reference as string, nr)
    await sql`
      INSERT INTO disco_menus (reference, restaurant_reference, name, url, type, description, image_url, visible, archived, position, availability_mode, start_date, end_date, schedule_config)
      VALUES (${nr}::uuid, ${newRef}::uuid, ${m.name}, ${m.url}, ${m.type}, ${m.description}, ${m.image_url}, ${m.visible}, ${m.archived}, ${m.position}, ${m.availability_mode}, ${m.start_date}, ${m.end_date}, ${m.schedule_config ? JSON.stringify(m.schedule_config) : null}::jsonb)`
  }

  // 2. Categories (remap menu_reference)
  const cats = (await sql`SELECT * FROM disco_menu_categories WHERE restaurant_reference = ${sourceRef}::uuid`) as Record<string, unknown>[]
  const catMap = new Map<string, string>()
  for (const c of cats) {
    const nr = randomUUID(); catMap.set(c.reference as string, nr)
    const newMenuRef = c.menu_reference ? menuMap.get(c.menu_reference as string) ?? null : null
    await sql`
      INSERT INTO disco_menu_categories (reference, restaurant_reference, menu_reference, name, description, position, visible)
      VALUES (${nr}::uuid, ${newRef}::uuid, ${newMenuRef}::uuid, ${c.name}, ${c.description}, ${c.position}, ${c.visible})`
  }

  // 3. Items (remap category_reference)
  const items = (await sql`SELECT * FROM disco_menu_items WHERE restaurant_reference = ${sourceRef}::uuid`) as Record<string, unknown>[]
  const itemMap = new Map<string, string>()
  for (const it of items) {
    const nr = randomUUID(); itemMap.set(it.reference as string, nr)
    const newCatRef = it.category_reference ? catMap.get(it.category_reference as string) ?? null : null
    await sql`
      INSERT INTO disco_menu_items (reference, restaurant_reference, category_reference, name, description, price, serves, visible, position, image_url, display_price, min_quantity, allow_special_instructions, vegetarian, contains_nuts, gluten_free, vegan)
      VALUES (${nr}::uuid, ${newRef}::uuid, ${newCatRef}::uuid, ${it.name}, ${it.description}, ${it.price}, ${it.serves}, ${it.visible}, ${it.position}, ${it.image_url}, ${it.display_price}, ${it.min_quantity}, ${it.allow_special_instructions}, ${it.vegetarian}, ${it.contains_nuts}, ${it.gluten_free}, ${it.vegan})`
  }

  // 4. Modifiers
  const mods = (await sql`SELECT * FROM disco_modifiers WHERE restaurant_reference = ${sourceRef}::uuid`) as Record<string, unknown>[]
  const modMap = new Map<string, string>()
  for (const m of mods) {
    const nr = randomUUID(); modMap.set(m.reference as string, nr)
    await sql`
      INSERT INTO disco_modifiers (reference, restaurant_reference, name, price, archived, visible, position)
      VALUES (${nr}::uuid, ${newRef}::uuid, ${m.name}, ${m.price}, ${m.archived}, ${m.visible}, ${m.position})`
  }

  // 5. Modifier groups
  const groups = (await sql`SELECT * FROM disco_modifier_groups WHERE restaurant_reference = ${sourceRef}::uuid`) as Record<string, unknown>[]
  const groupMap = new Map<string, string>()
  for (const g of groups) {
    const nr = randomUUID(); groupMap.set(g.reference as string, nr)
    await sql`
      INSERT INTO disco_modifier_groups (reference, restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, archived, visible, position)
      VALUES (${nr}::uuid, ${newRef}::uuid, ${g.name}, ${g.external_name}, ${g.sub_external_name}, ${g.min_selected}, ${g.max_selected}, ${g.archived}, ${g.visible}, ${g.position})`
  }

  // 6. Group ↔ modifier membership (remap both refs)
  if (groupMap.size) {
    const members = (await sql`SELECT * FROM disco_modifier_group_members WHERE group_reference = ANY(${[...groupMap.keys()]}::uuid[])`) as Record<string, unknown>[]
    for (const mm of members) {
      const g = groupMap.get(mm.group_reference as string), md = modMap.get(mm.modifier_reference as string)
      if (g && md) await sql`INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position) VALUES (${g}::uuid, ${md}::uuid, ${mm.position})`
    }
  }

  // 7. Item ↔ group attachment (remap both refs)
  if (itemMap.size) {
    const itemGroups = (await sql`SELECT * FROM disco_item_groups WHERE item_reference = ANY(${[...itemMap.keys()]}::uuid[])`) as Record<string, unknown>[]
    for (const ig of itemGroups) {
      const it = itemMap.get(ig.item_reference as string), g = groupMap.get(ig.group_reference as string)
      if (it && g) await sql`INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position) VALUES (${it}::uuid, ${g}::uuid, ${ig.enabled}, ${ig.position})`
    }
  }

  // 8. Restaurant-wide closed days / holidays
  const closed = (await sql`SELECT name, holiday, from_date, to_date FROM disco_restaurant_closed_days WHERE restaurant_reference = ${sourceRef}::uuid`) as Record<string, unknown>[]
  for (const cd of closed) {
    await sql`INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, holiday, from_date, to_date) VALUES (${newRef}::uuid, ${cd.name}, ${cd.holiday}, ${cd.from_date}, ${cd.to_date})`
  }
}
