import { sql } from '../db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ImportPackage {
  name: string
  description?: string
  price: number
  displayPrice?: string
  minQuantity?: number
  serves: number
  itemType: string
  category?: string
  modifiers?: string
}

export interface DiscoWriteSummary { menuReference: string | null; items: number; groups: number; modifiers: number; error?: string }

// Parse the AI-extracted modifier string into structured groups. The parser prompt
// emits "Group name: opt1, opt2, opt3", optionally several groups separated by ';'
// or newlines (e.g. "Choose protein: Chicken, Beef; Choose side: Rice, Beans").
export function parseModifierGroups(raw: string): { name: string; options: string[]; minSelected?: number; maxSelected?: number }[] {
  const groups: { name: string; options: string[]; minSelected?: number; maxSelected?: number }[] = []
  for (const seg of raw.split(/[\n;]+/).map(s => s.trim()).filter(Boolean)) {
    const ci = seg.indexOf(':')
    let name = 'Choose an option'
    let optsStr = seg
    if (ci >= 0) { name = seg.slice(0, ci).trim() || 'Choose an option'; optsStr = seg.slice(ci + 1) }
    const options = optsStr.split(',').map(o => o.trim()).filter(Boolean)
    if (options.length) groups.push({ name, options, ...parseSelectionCount(name) })
  }
  return groups
}

/**
 * Pull an explicit selection count out of a group NAME, when the source states one.
 *
 * Menu documents (and FM's own external names, which is where the convention comes
 * from) write the requirement into the label: "Select 2 Salads", "Select 4+
 * Sandwiches", "Select 1-2 Breads", "Choose up to 3". That is real information the
 * previous hardcoded 0/1 discarded. Returns {} when the name says nothing, so the
 * caller keeps its conservative default rather than guessing a requirement.
 */
function parseSelectionCount(name: string): { minSelected?: number; maxSelected?: number } {
  const s = name.toLowerCase()
  // "up to 3" / "at most 3" — a maximum with no minimum.
  const upTo = /\b(?:up to|at most|max(?:imum)? of)\s+(\d{1,2})\b/.exec(s)
  if (upTo) return { minSelected: 0, maxSelected: Number(upTo[1]) }
  // "select 1-2", "choose 2 to 4" — an explicit range.
  const range = /\b(?:select|choose|pick)\s+(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/.exec(s)
  if (range) return { minSelected: Number(range[1]), maxSelected: Number(range[2]) }
  // "select 4+" / "4 or more" — a minimum with no stated ceiling. Left open by
  // returning no maxSelected; the caller clamps to the option count.
  // NOTE no trailing \b: after a literal "+" the next char is a space, and both are
  // non-word, so \b cannot match there — with it, "Select 4+ Sandwiches" fell
  // through to the exact-count branch below and became min 4 / MAX 4, silently
  // capping a deliberately uncapped group. Caught by verify-item-minimums.ts.
  const orMore = /\b(?:select|choose|pick)\s+(\d{1,2})\s*(?:\+|or more\b)/.exec(s)
  if (orMore) return { minSelected: Number(orMore[1]) }
  // "select 2 salads", "choose exactly 3" — an exact count.
  const exact = /\b(?:select|choose|pick)\s+(?:exactly\s+)?(\d{1,2})\b/.exec(s)
  if (exact) return { minSelected: Number(exact[1]), maxSelected: Number(exact[1]) }
  return {}
}

// #6 dual-write: mirror the imported packages into the Disco-native menu tables so
// the restaurant portal's Manage Menus shows them (the FM write alone only surfaces
// on the customer-facing FM menu). Structure is preserved: menu → categories →
// items → modifier groups/modifiers (linked via disco_item_groups), never flattened
// to a string. Best-effort and isolated — a failure here must not fail the FM import.
export async function writeDiscoNativeMenu(ref: string, packages: ImportPackage[]): Promise<DiscoWriteSummary> {
  const summary: DiscoWriteSummary = { menuReference: null, items: 0, groups: 0, modifiers: 0 }
  // Disco tables key on a UUID restaurant_reference; skip cleanly if we weren't
  // given one (the FM import still succeeds).
  if (!UUID_RE.test(ref)) { console.warn('[menu-import] restaurantReference is not a UUID — skipping Disco-native write:', ref); return summary }

  // Reuse a prior "Imported Menu" for this restaurant, else create one.
  const existing = (await sql`SELECT reference FROM disco_menus WHERE restaurant_reference = ${ref}::uuid AND name = 'Imported Menu' AND archived = false ORDER BY id LIMIT 1`) as { reference: string }[]
  let menuRef = existing[0]?.reference
  if (!menuRef) {
    const mp = (await sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM disco_menus WHERE restaurant_reference = ${ref}::uuid`) as { p: number }[]
    const ins = (await sql`INSERT INTO disco_menus (restaurant_reference, name, type, position) VALUES (${ref}::uuid, 'Imported Menu', 'GENERAL_CATERING', ${mp[0]?.p ?? 0}) RETURNING reference`) as { reference: string }[]
    menuRef = ins[0].reference
  }
  summary.menuReference = menuRef

  // Find-or-create a category within this menu (cached per run).
  const catCache = new Map<string, string>()
  const getCategory = async (rawName: string): Promise<string> => {
    const name = rawName || 'Imported'
    const hit = catCache.get(name)
    if (hit) return hit
    const found = (await sql`SELECT reference FROM disco_menu_categories WHERE restaurant_reference = ${ref}::uuid AND menu_reference = ${menuRef}::uuid AND name = ${name} LIMIT 1`) as { reference: string }[]
    let cref = found[0]?.reference
    if (!cref) {
      const cp = (await sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM disco_menu_categories WHERE menu_reference = ${menuRef}::uuid`) as { p: number }[]
      const ins = (await sql`INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name, position) VALUES (${ref}::uuid, ${menuRef}::uuid, ${name}, ${cp[0]?.p ?? 0}) RETURNING reference`) as { reference: string }[]
      cref = ins[0].reference
    }
    catCache.set(name, cref)
    return cref
  }

  let itemPos = 0
  for (const p of packages) {
    const name = String(p?.name ?? '').trim()
    if (!name) continue
    const catRef = await getCategory(String(p?.category ?? '').trim())
    const price = Number.isFinite(Number(p?.price)) ? Number(p?.price) : 0
    const serves = p?.serves != null && String(p.serves).trim() ? String(p.serves).trim() : null
    const displayPrice = p?.displayPrice?.trim() ? p.displayPrice.trim() : null
    const minQty = Number.isFinite(Number(p?.minQuantity)) && Number(p?.minQuantity) > 0 ? Math.round(Number(p?.minQuantity)) : null
    const itemIns = (await sql`
      INSERT INTO disco_menu_items (restaurant_reference, category_reference, name, description, price, serves, display_price, min_quantity, position)
      VALUES (${ref}::uuid, ${catRef}::uuid, ${name}, ${String(p?.description ?? '')}, ${price}, ${serves}, ${displayPrice}, ${minQty}, ${itemPos++})
      RETURNING reference
    `) as { reference: string }[]
    const itemRef = itemIns[0].reference
    summary.items++

    // Structured modifier groups from the parsed string.
    //
    // min/max SELECTION COUNTS ARE NOT IN THIS SOURCE. Unlike fm-faithful-import,
    // which reads FM's real minSelectedItems/maxSelectedItems, the input here is a
    // free-text `modifiers` string an LLM extracted from an uploaded menu document
    // ("Choose protein: Chicken, Beef"). A menu PDF rarely states a selection count
    // in machine-readable form, so there is usually nothing to carry — these are
    // DEFAULTS, not dropped data.
    //
    // The previous hardcoded 0/1 was still a poor default: it silently made every
    // extracted group optional AND single-select, so a group the source clearly
    // described as "Select 2 Salads" became "pick at most one, or none". Where the
    // group name does state a count — which is exactly how FM's own external names
    // read ("Select 2 Salads", "Select 4+ Sandwiches") — parseModifierGroups now
    // reads it and we honour it; otherwise we keep 0/1, because inventing a
    // requirement from a guess would block checkout on an item nobody can complete.
    let gpos = 0
    for (const g of parseModifierGroups(String(p?.modifiers ?? '').trim())) {
      const minSel = Math.max(0, Math.min(g.minSelected ?? 0, g.options.length))
      const maxSel = Math.max(1, Math.min(g.maxSelected ?? 1, g.options.length))
      const gIns = (await sql`
        INSERT INTO disco_modifier_groups (restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, position)
        VALUES (${ref}::uuid, ${g.name}, ${g.name}, ${minSel > 0 ? 'Required' : 'Optional'}, ${minSel}, ${Math.max(minSel, maxSel)}, ${gpos})
        RETURNING reference
      `) as { reference: string }[]
      const groupRef = gIns[0].reference
      summary.groups++
      let mpos = 0
      for (const optName of g.options) {
        const mIns = (await sql`INSERT INTO disco_modifiers (restaurant_reference, name, price, position) VALUES (${ref}::uuid, ${optName}, 0, ${mpos}) RETURNING reference`) as { reference: string }[]
        await sql`INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position) VALUES (${groupRef}::uuid, ${mIns[0].reference}::uuid, ${mpos})`
        summary.modifiers++
        mpos++
      }
      await sql`INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position) VALUES (${itemRef}::uuid, ${groupRef}::uuid, true, ${gpos}) ON CONFLICT (item_reference, group_reference) DO NOTHING`
      gpos++
    }
  }
  return summary
}
