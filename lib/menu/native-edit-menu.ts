// The menu the ORDER EDIT dialog offers, for a Disco-native restaurant.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The edit dialog built its menu from FamilyMeal — /api/fm-menu then
// /api/fm-packages — for every restaurant, including the 759 that have
// converted. The customer ordering page, by contrast, builds a native
// restaurant's menu from Neon (see app/(customer)/restaurants/[slug]/shared.tsx).
// Two surfaces, two sources, and after conversion Disco owns the menu — so the
// dialog was showing a snapshot FamilyMeal stopped being authoritative for.
//
// It surfaced as missing OPTIONAL modifier groups. On order #900000272 at
// DeCheco's Pizzeria - Hudson, "gluten-free build your own" offers two groups in
// Neon — "byo- sauce" (Required, 2 options) and "gf byo - toppings" (Optional,
// 29 options) — while FamilyMeal returns only the sauce group for that item at
// that location. Nothing in the dialog filtered optional groups out; it was
// faithfully rendering everything its source gave it, and its source was wrong.
//
// This returns the SAME shape the FM path produced (MenuSection[] with
// extraItemsGroups on each package) so the dialog renders it unchanged, and it
// reads the same tables as the customer page so the two can no longer disagree.
import { sql } from '../db'

export interface NativeAddOn { reference: string; name: string; price: number; visible: boolean; position: number }
export interface NativeExtraItemsGroup {
  reference: string; name: string
  externalName?: string; subExternalName?: string
  minSelectedItems: number; maxSelectedItems: number
  visible: boolean; enabled: boolean
  addOns: NativeAddOn[]
}
export interface NativePackage {
  reference: string; name: string; description: string | null; price: number
  serves: string | null; allowedSpecialInstructions: boolean
  minQuantity?: number
  /** Already a full URL — native item images are re-hosted in Vercel Blob at
   *  import, so there is no FM image reference to resolve. */
  imageUrl?: string
  extraItemsGroups: NativeExtraItemsGroup[]
}
export interface NativeCategory { reference: string; name: string; description: string | null; mealPackages: NativePackage[] }
export interface NativeMenuSection { menu: { reference: string; name: string; position: number }; categories: NativeCategory[] }

/**
 * Menus → categories → items → modifier groups for a native restaurant.
 *
 * Mirrors the customer page's filters exactly, because the whole point is that
 * staff see what the customer sees: only visible menus/categories/items, only
 * ENABLED group attachments, and only groups and modifiers that are both
 * non-archived and visible.
 *
 * Returns null when the restaurant is not Disco-native, so the caller can fall
 * through to FamilyMeal for the ~3,400 restaurants that have not converted.
 */
export async function loadNativeEditMenu(restaurantRef: string): Promise<NativeMenuSection[] | null> {
  if (!restaurantRef) return null

  const nativeRows = (await sql`
    SELECT is_disco_native FROM disco_restaurant_cache
    WHERE restaurant_reference = ${restaurantRef} LIMIT 1
  `.catch(() => [])) as { is_disco_native: boolean | null }[]
  if (!nativeRows[0]?.is_disco_native) return null

  const menus = (await sql`
    SELECT reference, name, position FROM disco_menus
    WHERE restaurant_reference = ${restaurantRef}::uuid AND visible = true AND archived = false
    ORDER BY position, name
  `.catch(() => [])) as { reference: string; name: string; position: number | null }[]
  if (!menus.length) return []

  const cats = (await sql`
    SELECT reference, name, description, menu_reference FROM disco_menu_categories
    WHERE restaurant_reference = ${restaurantRef}::uuid AND visible = true
    ORDER BY position, name
  `.catch(() => [])) as { reference: string; name: string; description: string | null; menu_reference: string | null }[]

  const items = (await sql`
    SELECT reference, category_reference, name, description, price, serves,
           min_quantity, allow_special_instructions, image_url
    FROM disco_menu_items
    WHERE restaurant_reference = ${restaurantRef}::uuid AND visible = true
    ORDER BY position, name
  `.catch(() => [])) as {
    reference: string; category_reference: string | null; name: string; description: string | null
    price: string | number; serves: string | null; min_quantity: number | null; allow_special_instructions: boolean
    image_url: string | null
  }[]

  // ── MODIFIER GROUPS ───────────────────────────────────────────────────────
  // The same three-table walk the customer page performs. No filter on
  // min_selected: a group with min 0 is OPTIONAL, not absent, and dropping it is
  // the defect this module exists to fix.
  const groupsByItem = new Map<string, NativeExtraItemsGroup[]>()
  try {
    const attach = (await sql`
      SELECT ig.item_reference, ig.position,
             g.reference, g.name, g.external_name, g.sub_external_name, g.min_selected, g.max_selected
      FROM disco_item_groups ig
      JOIN disco_menu_items mi ON mi.reference = ig.item_reference AND mi.restaurant_reference = ${restaurantRef}::uuid
      JOIN disco_modifier_groups g ON g.reference = ig.group_reference AND g.archived = false AND g.visible = true
      WHERE ig.enabled = true
      ORDER BY ig.position, g.name
    `) as { item_reference: string; position: number; reference: string; name: string; external_name: string | null; sub_external_name: string | null; min_selected: number; max_selected: number }[]

    const groupRefs = [...new Set(attach.map(a => a.reference))]
    const members = groupRefs.length ? (await sql`
      SELECT gm.group_reference, gm.position, m.reference, m.name, m.price
      FROM disco_modifier_group_members gm
      JOIN disco_modifiers m ON m.reference = gm.modifier_reference AND m.archived = false AND m.visible = true
      WHERE gm.group_reference = ANY(${groupRefs})
      ORDER BY gm.position, m.name
    `) as { group_reference: string; position: number; reference: string; name: string; price: string | number }[] : []

    const addOnsByGroup = new Map<string, NativeAddOn[]>()
    members.forEach((m, i) => {
      const l = addOnsByGroup.get(m.group_reference) ?? []
      l.push({ reference: m.reference, name: m.name, price: Number(m.price) || 0, visible: true, position: i })
      addOnsByGroup.set(m.group_reference, l)
    })
    for (const a of attach) {
      const l = groupsByItem.get(a.item_reference) ?? []
      l.push({
        reference: a.reference, name: a.name,
        externalName: a.external_name || undefined, subExternalName: a.sub_external_name || undefined,
        minSelectedItems: a.min_selected, maxSelectedItems: a.max_selected,
        visible: true, enabled: true,
        addOns: addOnsByGroup.get(a.reference) ?? [],
      })
      groupsByItem.set(a.item_reference, l)
    }
  } catch (e) {
    // A modifier failure must not cost the operator the whole menu — they can
    // still add plain items. Loud, because a silently modifier-less menu is the
    // exact shape of the bug this replaced.
    console.error('[native-edit-menu] modifier groups failed to load; menu returned without them:', e instanceof Error ? e.message : e)
  }

  const primary = menus[0]
  return menus.map(m => ({
    menu: { reference: m.reference, name: m.name, position: m.position ?? 0 },
    categories: cats
      // A category whose menu_reference is NULL predates the multi-menu model
      // and belongs to the primary menu — the same fallback the customer page
      // applies, so staff and customer group items identically.
      .filter(c => c.menu_reference === m.reference || (c.menu_reference == null && m.reference === primary.reference))
      .map(c => ({
        reference: c.reference,
        name: c.name,
        description: c.description,
        mealPackages: items
          .filter(it => it.category_reference === c.reference)
          .map(it => ({
            reference: it.reference,
            name: it.name,
            description: it.description,
            price: Number(it.price) || 0,
            serves: it.serves,
            allowedSpecialInstructions: it.allow_special_instructions === true,
            minQuantity: it.min_quantity ?? undefined,
            imageUrl: it.image_url || undefined,
            extraItemsGroups: groupsByItem.get(it.reference) ?? [],
          })),
      })),
  }))
}
