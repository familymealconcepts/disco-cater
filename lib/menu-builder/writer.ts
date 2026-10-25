// THE ONLY CODE THE MENU BUILDER WRITES THROUGH (Peter, 25 Oct 2026).
//
// Scope, enforced here and not left to the prompt:
//   • Tables: disco_menus, disco_menu_categories, disco_menu_items,
//     disco_modifier_groups, disco_modifiers, disco_modifier_group_members,
//     disco_item_groups. Nothing else — no restaurant settings, Stripe, users,
//     access, or anything in FamilyMeal.
//   • Restaurants: only the session's own locations (chosen at the start and
//     verified Disco-native then), re-checked on every write against the
//     menu's own restaurant_reference.
//   • Visibility: a new menu is written hidden; only publishNew() turns menus
//     on, and only after every location's copy has been read back and matched.
//     An update is saved only by applyUpdate(), which the Confirm button calls.
//   • Images: only URLs this session re-hosted from uploads, or the image the
//     item already had. A URL the model makes up is dropped, never fetched.
//
// Each menu is written in ONE sql.transaction with references generated up
// front, so a draft is never left half-written.

import { randomUUID } from 'crypto'
import { sql } from '../db'
import { type MenuSpec, type SpecGroup, type SpecItem, readMenuSpec, fingerprint, diffSpecs, type Change } from './spec'
import type { SessionRow } from './store'

type Stmt = ReturnType<typeof sql>

function assertScope(session: SessionRow, restaurantRef: string) {
  if (!session.restaurant_refs.includes(restaurantRef)) throw new Error(`Restaurant ${restaurantRef} is not one of this session's locations.`)
}

async function menuOwner(menuRef: string): Promise<{ restaurant_reference: string; visible: boolean } | null> {
  const r = (await sql`SELECT restaurant_reference::text AS restaurant_reference, visible FROM disco_menus WHERE reference = ${menuRef}::uuid`) as { restaurant_reference: string; visible: boolean }[]
  return r[0] ?? null
}

const slug = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'menu'

/** schedule_config the way the portal stores it. SAME_DAY ignores perDay, so differing windows must be CUSTOM. */
function scheduleConfig(spec: MenuSpec) {
  const w = spec.settings.windows
  if (!w.length) return null
  const same = w.every(x => x.from === w[0].from && x.to === w[0].to)
  const perDay = Object.fromEntries(w.map(x => [x.day, { from: x.from, to: x.to }]))
  return { days: w.map(x => x.day), perDay, sameWindow: { from: w[0].from, to: w[0].to }, scheduleType: same ? 'SAME_DAY' : 'CUSTOM' }
}

/**
 * Delivery fees are the restaurant's own configuration, not something read off
 * a menu file: a new menu takes the delivery settings of that location's most
 * recently updated menu that offers delivery (none → the portal's default, null).
 */
async function locationDeliverySettings(rest: string): Promise<unknown> {
  const r = (await sql`
    SELECT delivery_settings FROM disco_menus
     WHERE restaurant_reference = ${rest}::uuid AND offers_delivery = true AND delivery_settings IS NOT NULL
     ORDER BY archived ASC, updated_at DESC NULLS LAST LIMIT 1`) as { delivery_settings: unknown }[]
  return r[0]?.delivery_settings ?? null
}

/** The image an item may have: a photo re-hosted in this session, or the one it already had. Nothing else. */
export type ImageResolver = (value: string | null) => string | null
export function imageResolver(session: SessionRow, allowedExisting: Set<string>): ImageResolver {
  const byName = new Map(session.images.map(i => [i.name.toLowerCase(), i.url]))
  const ours = new Set(session.images.map(i => i.url))
  return (v) => {
    if (!v) return null
    const named = byName.get(v.toLowerCase())
    if (named) return named
    if (ours.has(v) || allowedExisting.has(v)) return v
    return null
  }
}

function groupStmts(rest: string, menuName: string, itemName: string, g: SpecGroup, groupRef: string, position: number): Stmt[] {
  const out: Stmt[] = [sql`
    INSERT INTO disco_modifier_groups (reference, restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, visible, position)
    VALUES (${groupRef}::uuid, ${rest}::uuid, ${`${menuName} - ${itemName} - ${g.title}`.slice(0, 255)}, ${g.title}, ${g.subtitle}, ${g.min}, ${g.max}, true, ${position})`]
  g.options.forEach((o, i) => {
    const mr = randomUUID()
    out.push(sql`INSERT INTO disco_modifiers (reference, restaurant_reference, name, price, visible, position) VALUES (${mr}::uuid, ${rest}::uuid, ${o.name}, ${o.price}, true, ${i})`)
    out.push(sql`INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position) VALUES (${groupRef}::uuid, ${mr}::uuid, ${i})`)
  })
  return out
}

function itemInsertStmts(rest: string, menuName: string, catRef: string, it: SpecItem, pos: number, img: ImageResolver): Stmt[] {
  const ir = randomUUID()
  const out: Stmt[] = [sql`
    INSERT INTO disco_menu_items (reference, restaurant_reference, category_reference, name, description, price, display_price, serves, visible, position,
      image_url, min_quantity, allow_special_instructions, vegetarian, vegan, gluten_free, dairy_free, contains_nuts)
    VALUES (${ir}::uuid, ${rest}::uuid, ${catRef}::uuid, ${it.name}, ${it.description}, ${it.price}, ${it.display_price}, ${it.serves}, true, ${pos},
      ${img(it.image)}, ${it.min_quantity}, true, ${it.vegetarian}, ${it.vegan}, ${it.gluten_free}, ${it.dairy_free}, ${it.contains_nuts})`]
  it.option_groups.forEach((g, gi) => {
    const gr = randomUUID()
    out.push(...groupStmts(rest, menuName, it.name, g, gr, gi))
    out.push(sql`INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position) VALUES (${ir}::uuid, ${gr}::uuid, true, ${gi})`)
  })
  return out
}

function contentStmts(rest: string, menuRef: string, spec: MenuSpec, img: ImageResolver): Stmt[] {
  const out: Stmt[] = []
  spec.categories.forEach((c, ci) => {
    const cr = randomUUID()
    out.push(sql`INSERT INTO disco_menu_categories (reference, restaurant_reference, menu_reference, name, description, position, visible)
                 VALUES (${cr}::uuid, ${rest}::uuid, ${menuRef}::uuid, ${c.name}, ${c.description}, ${ci}, true)`)
    c.items.forEach((it, ii) => out.push(...itemInsertStmts(rest, spec.name, cr, it, ii, img)))
  })
  return out
}

/** Remove a menu's categories, items, their links, and the groups no other item uses. */
function clearContentStmts(menuRef: string): Stmt[] {
  return [
    sql`
      WITH items AS (
        SELECT i.reference FROM disco_menu_items i JOIN disco_menu_categories c ON c.reference = i.category_reference
         WHERE c.menu_reference = ${menuRef}::uuid
      ), own_groups AS (
        SELECT ig.group_reference FROM disco_item_groups ig WHERE ig.item_reference IN (SELECT reference FROM items)
        EXCEPT
        SELECT ig.group_reference FROM disco_item_groups ig WHERE ig.item_reference NOT IN (SELECT reference FROM items)
      ), own_mods AS (
        SELECT gm.modifier_reference FROM disco_modifier_group_members gm WHERE gm.group_reference IN (SELECT group_reference FROM own_groups)
        EXCEPT
        SELECT gm.modifier_reference FROM disco_modifier_group_members gm WHERE gm.group_reference NOT IN (SELECT group_reference FROM own_groups)
      ), d_links AS (
        DELETE FROM disco_item_groups WHERE item_reference IN (SELECT reference FROM items) RETURNING 1
      ), d_members AS (
        DELETE FROM disco_modifier_group_members WHERE group_reference IN (SELECT group_reference FROM own_groups) RETURNING 1
      ), d_mods AS (
        DELETE FROM disco_modifiers WHERE reference IN (SELECT modifier_reference FROM own_mods) RETURNING 1
      ), d_groups AS (
        DELETE FROM disco_modifier_groups WHERE reference IN (SELECT group_reference FROM own_groups) RETURNING 1
      )
      DELETE FROM disco_menu_items WHERE reference IN (SELECT reference FROM items)`,
    sql`DELETE FROM disco_menu_categories WHERE menu_reference = ${menuRef}::uuid`,
  ]
}

function menuSettingsUpdateStmt(menuRef: string, spec: MenuSpec, writeSchedule = true): Stmt {
  const s = spec.settings
  return sql`
    UPDATE disco_menus SET
      name = ${spec.name}, type = ${spec.type}, description = ${spec.description},
      availability_mode = ${s.availability_mode},
      start_date = ${s.availability_mode === 'CUSTOM' ? s.start_date : null}::date,
      end_date = ${s.availability_mode === 'CUSTOM' ? s.end_date : null}::date,
      schedule_config = CASE WHEN ${writeSchedule} THEN ${JSON.stringify(scheduleConfig(spec))}::jsonb ELSE schedule_config END,
      offers_pickup = ${s.offers_pickup}, offers_delivery = ${s.offers_delivery},
      lead_time_hours = ${s.lead_time_hours}, hard_cutoff_date = ${s.hard_cutoff_date}::date, hard_cutoff_time = ${s.hard_cutoff_time}::time,
      tip_default_type = ${s.tip_default_type}, tip_default_value = ${s.tip_default_value},
      service_charge_pct = ${s.service_charge_pct}, pickup_order_minimum = ${s.pickup_order_minimum},
      delivery_order_minimum = ${s.delivery_order_minimum}, max_orders_per_day = ${s.max_orders_per_day},
      rolling_availability_days = ${s.rolling_availability_days}, include_utensils = ${s.include_utensils},
      updated_at = NOW()
    WHERE reference = ${menuRef}::uuid`
}

async function insertHiddenMenu(rest: string, spec: MenuSpec): Promise<{ ref: string; stmt: Stmt }> {
  const ref = randomUUID()
  const base = slug(spec.name)
  let url = base
  for (let i = 2; ((await sql`SELECT 1 FROM disco_menus WHERE restaurant_reference = ${rest}::uuid AND url = ${url}`) as unknown[]).length; i++) url = `${base}-${i}`
  const s = spec.settings
  const stmt = sql`
    INSERT INTO disco_menus (
      reference, restaurant_reference, name, url, type, description, visible, archived,
      availability_mode, start_date, end_date, schedule_config, offers_pickup, offers_delivery,
      service_charge_pct, tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
      max_orders_per_day, lead_time_hours, rolling_availability_days, hard_cutoff_date, hard_cutoff_time,
      delivery_settings, include_utensils, position, created_at, updated_at
    ) VALUES (
      ${ref}::uuid, ${rest}::uuid, ${spec.name}, ${url}, ${spec.type}, ${spec.description}, false, false,
      ${s.availability_mode}, ${s.availability_mode === 'CUSTOM' ? s.start_date : null}::date, ${s.availability_mode === 'CUSTOM' ? s.end_date : null}::date,
      ${JSON.stringify(scheduleConfig(spec))}::jsonb, ${s.offers_pickup}, ${s.offers_delivery},
      ${s.service_charge_pct}, ${s.tip_default_type}, ${s.tip_default_value}, ${s.pickup_order_minimum}, ${s.delivery_order_minimum},
      ${s.max_orders_per_day}, ${s.lead_time_hours}, ${s.rolling_availability_days}, ${s.hard_cutoff_date}::date, ${s.hard_cutoff_time}::time,
      ${JSON.stringify(await locationDeliverySettings(rest))}::jsonb, ${s.include_utensils},
      (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menus WHERE restaurant_reference = ${rest}::uuid), NOW(), NOW()
    )`
  return { ref, stmt }
}

/**
 * Write (or rewrite) a session's HIDDEN draft at its first location. A draft
 * that has somehow become visible is never rewritten — that is a live menu.
 */
export async function writeDraft(session: SessionRow, spec: MenuSpec): Promise<string> {
  const rest = session.restaurant_refs[0]
  assertScope(session, rest)
  const img = imageResolver(session, new Set())
  if (session.draft_menu_ref) {
    const own = await menuOwner(session.draft_menu_ref)
    if (own) {
      if (own.restaurant_reference !== rest) throw new Error('Draft belongs to another restaurant.')
      if (own.visible) throw new Error('This menu is already live; start a new session to change it.')
      await sql.transaction([
        ...clearContentStmts(session.draft_menu_ref),
        menuSettingsUpdateStmt(session.draft_menu_ref, spec),
        sql`UPDATE disco_menus SET visible = false WHERE reference = ${session.draft_menu_ref}::uuid`,
        ...contentStmts(rest, session.draft_menu_ref, spec, img),
      ])
      return session.draft_menu_ref
    }
  }
  const m = await insertHiddenMenu(rest, spec)
  await sql.transaction([m.stmt, ...contentStmts(rest, m.ref, spec, img)])
  return m.ref
}

/** Delete a never-published menu this session made (its draft, or a hidden copy from a publish that did not finish). */
export async function discardHiddenMenu(session: SessionRow, menuRef: string): Promise<boolean> {
  const own = await menuOwner(menuRef)
  if (!own) return false
  assertScope(session, own.restaurant_reference)
  if (own.visible) throw new Error('This menu is live; it can only be changed from the menu manager.')
  await sql.transaction([...clearContentStmts(menuRef), sql`DELETE FROM disco_menus WHERE reference = ${menuRef}::uuid AND visible = false`])
  return true
}

/**
 * Publish a new menu: copy the checked draft (read back from Neon, not the
 * bot's JSON) to every other location, hidden; read every copy back and
 * compare it with the draft; only if all match, turn them all on in ONE
 * statement. A mismatch leaves everything hidden and says where.
 */
export async function publishNew(session: SessionRow, priorCopies: Record<string, string>): Promise<{
  menus: Record<string, string>; matched: boolean; mismatches: string[]
}> {
  const draftRef = session.draft_menu_ref
  if (!draftRef) throw new Error('There is no draft to publish yet.')
  const draft = await readMenuSpec(draftRef)
  if (!draft) throw new Error('The draft no longer exists.')
  assertScope(session, draft.restaurantRef)
  if (draft.restaurantRef !== session.restaurant_refs[0]) throw new Error('Draft belongs to another restaurant.')
  const existingImages = new Set(draft.spec.categories.flatMap(c => c.items.map(i => i.image)).filter((x): x is string => !!x))
  const img = imageResolver(session, existingImages)
  const menus: Record<string, string> = { [draft.restaurantRef]: draftRef }
  for (const rest of session.restaurant_refs.slice(1)) {
    assertScope(session, rest)
    const prior = priorCopies[rest]
    const own = prior ? await menuOwner(prior) : null
    if (prior && own && own.restaurant_reference === rest && !own.visible) {
      await sql.transaction([...clearContentStmts(prior), menuSettingsUpdateStmt(prior, draft.spec), ...contentStmts(rest, prior, draft.spec, img)])
      menus[rest] = prior
    } else {
      const m = await insertHiddenMenu(rest, draft.spec)
      await sql.transaction([m.stmt, ...contentStmts(rest, m.ref, draft.spec, img)])
      menus[rest] = m.ref
    }
  }
  const want = fingerprint(draft.spec)
  const mismatches: string[] = []
  for (const [rest, ref] of Object.entries(menus)) {
    const got = await readMenuSpec(ref)
    if (!got || fingerprint(got.spec) !== want) mismatches.push(rest)
  }
  if (mismatches.length) return { menus, matched: false, mismatches }
  const refs = Object.values(menus)
  await sql`UPDATE disco_menus SET visible = true, updated_at = NOW()
             WHERE reference = ANY(${refs}::uuid[]) AND restaurant_reference = ANY(${session.restaurant_refs}::uuid[])`
  return { menus, matched: true, mismatches: [] }
}

// ── Update an existing menu in place ─────────────────────────────────────────

/**
 * The bot proposes `after` against the FIRST location's menu (refs from it).
 * For every other location, map each ref to its name at the first location and
 * find the thing with that name at this one. What has no counterpart is new.
 */
export function translateForLocation(after: MenuSpec, primaryBefore: MenuSpec, localBefore: MenuSpec): MenuSpec {
  const pCat = new Map(primaryBefore.categories.map(c => [c.ref, c.name]))
  const pItem = new Map<string, { name: string; groups: Map<string, string> }>()
  for (const c of primaryBefore.categories) for (const i of c.items) pItem.set(i.ref!, { name: i.name, groups: new Map(i.option_groups.map(g => [g.ref!, g.title])) })
  const lItems = localBefore.categories.flatMap(c => c.items)
  return {
    ...after,
    categories: after.categories.map(c => {
      const nm = c.ref ? pCat.get(c.ref) : undefined
      const lc = localBefore.categories.find(x => x.name === (nm ?? c.name))
      return {
        ...c, ref: lc?.ref ?? null,
        items: c.items.map(i => {
          const p = i.ref ? pItem.get(i.ref) : undefined
          const li = lItems.find(x => x.name === (p?.name ?? i.name))
          return {
            ...i, ref: li?.ref ?? null,
            option_groups: i.option_groups.map(g => {
              const title = g.ref ? p?.groups.get(g.ref) : undefined
              const lg = li?.option_groups.find(x => x.title === (title ?? g.title))
              return { ...g, ref: lg?.ref ?? null }
            }),
          }
        }),
      }
    }),
  }
}

export type LocationPlan = { restaurantRef: string; menuRef: string; beforeFingerprint: string; after: MenuSpec; changes: Change[] }

/** Build the before → after for every location. Reads only. */
export async function planUpdate(session: SessionRow, after: MenuSpec): Promise<LocationPlan[]> {
  const targets = session.target_menu_refs || {}
  const primaryRest = session.restaurant_refs[0]
  const primary = await readMenuSpec(targets[primaryRest])
  if (!primary) throw new Error('The menu being updated no longer exists.')
  const plans: LocationPlan[] = []
  for (const rest of session.restaurant_refs) {
    assertScope(session, rest)
    const menuRef = targets[rest]
    const cur = menuRef ? await readMenuSpec(menuRef) : null
    if (!cur || cur.restaurantRef !== rest) throw new Error(`No menu named "${session.target_menu_name}" at one of the locations.`)
    const a = rest === primaryRest ? after : translateForLocation(after, primary.spec, cur.spec)
    plans.push({ restaurantRef: rest, menuRef, beforeFingerprint: fingerprint(cur.spec), after: a, changes: diffSpecs(cur.spec, a) })
  }
  return plans
}

const sameGroups = (a: SpecGroup[], b: SpecGroup[]) =>
  JSON.stringify(a.map(g => [g.title, g.subtitle, g.min, g.max, g.options])) === JSON.stringify(b.map(g => [g.title, g.subtitle, g.min, g.max, g.options]))

/**
 * Apply one location's confirmed plan. Refuses if the menu changed after the
 * preview was shown (its fingerprint no longer matches), so what is saved is
 * exactly what was confirmed.
 */
export async function applyPlan(session: SessionRow, plan: LocationPlan): Promise<{ changes: number }> {
  assertScope(session, plan.restaurantRef)
  const cur = await readMenuSpec(plan.menuRef)
  if (!cur || cur.restaurantRef !== plan.restaurantRef) throw new Error('Menu not found at this location.')
  if (fingerprint(cur.spec) !== plan.beforeFingerprint) throw new Error('This menu was changed after the preview was shown. Ask the builder to show the changes again.')
  const rest = plan.restaurantRef
  const before = cur.spec
  const after = plan.after
  const existingImages = new Set(before.categories.flatMap(c => c.items.map(i => i.image)).filter((x): x is string => !!x))
  const img = imageResolver(session, existingImages)

  const bCats = new Map(before.categories.map(c => [c.ref!, c]))
  const bItems = new Map<string, SpecItem>()
  for (const c of before.categories) for (const i of c.items) bItems.set(i.ref!, i)
  // Which groups are used by items OUTSIDE the item being edited (any menu).
  const allGroupRefs = [...new Set(before.categories.flatMap(c => c.items.flatMap(i => i.option_groups.map(g => g.ref!))))]
  const usage = allGroupRefs.length ? (await sql`
    SELECT group_reference::text AS g, item_reference::text AS i FROM disco_item_groups WHERE group_reference = ANY(${allGroupRefs}::uuid[])`) as { g: string; i: string }[] : []
  const usersOf = new Map<string, Set<string>>()
  for (const u of usage) { const s = usersOf.get(u.g) || new Set(); s.add(u.i); usersOf.set(u.g, s) }

  // The schedule is rewritten only when its windows actually changed, so an
  // unrelated update never re-serialises a schedule the portal wrote.
  const windowsChanged = JSON.stringify(before.settings.windows) !== JSON.stringify(after.settings.windows)
  const stmts: Stmt[] = [menuSettingsUpdateStmt(plan.menuRef, after, windowsChanged)]
  // Park category names first so a rename/swap can't trip the (menu, name) unique index.
  stmts.push(sql`UPDATE disco_menu_categories SET name = '~mb~' || reference::text WHERE menu_reference = ${plan.menuRef}::uuid`)
  const keptCats = new Set<string>()
  const keptItems = new Set<string>()
  after.categories.forEach((c, ci) => {
    let cr = c.ref && bCats.has(c.ref) ? c.ref : null
    if (cr) {
      keptCats.add(cr)
      stmts.push(sql`UPDATE disco_menu_categories SET name = ${c.name}, description = ${c.description}, position = ${ci}, updated_at = NOW() WHERE reference = ${cr}::uuid`)
    } else {
      cr = randomUUID()
      stmts.push(sql`INSERT INTO disco_menu_categories (reference, restaurant_reference, menu_reference, name, description, position, visible)
                     VALUES (${cr}::uuid, ${rest}::uuid, ${plan.menuRef}::uuid, ${c.name}, ${c.description}, ${ci}, true)`)
    }
    c.items.forEach((it, ii) => {
      const old = it.ref ? bItems.get(it.ref) : undefined
      if (!old) { stmts.push(...itemInsertStmts(rest, after.name, cr!, it, ii, img)); return }
      keptItems.add(old.ref!)
      stmts.push(sql`
        UPDATE disco_menu_items SET category_reference = ${cr}::uuid, name = ${it.name}, description = ${it.description}, price = ${it.price},
          display_price = ${it.display_price}, serves = ${it.serves}, min_quantity = ${it.min_quantity}, position = ${ii},
          image_url = ${img(it.image)}, vegetarian = ${it.vegetarian}, vegan = ${it.vegan}, gluten_free = ${it.gluten_free},
          dairy_free = ${it.dairy_free}, contains_nuts = ${it.contains_nuts}, updated_at = NOW()
        WHERE reference = ${old.ref}::uuid`)
      if (sameGroups(old.option_groups, it.option_groups)) return
      const keptGroups = new Set<string>()
      it.option_groups.forEach((g, gi) => {
        const og = g.ref ? old.option_groups.find(x => x.ref === g.ref) : undefined
        const users = og ? usersOf.get(og.ref!) : undefined
        const exclusive = !!og && !!users && users.size === 1 && users.has(old.ref!)
        if (og && exclusive) {
          keptGroups.add(og.ref!)
          stmts.push(sql`UPDATE disco_modifier_groups SET external_name = ${g.title}, sub_external_name = ${g.subtitle}, min_selected = ${g.min}, max_selected = ${g.max}, updated_at = NOW() WHERE reference = ${og.ref}::uuid`)
          stmts.push(sql`UPDATE disco_item_groups SET position = ${gi} WHERE item_reference = ${old.ref}::uuid AND group_reference = ${og.ref}::uuid`)
          if (JSON.stringify(og.options) !== JSON.stringify(g.options)) {
            // Options are matched by name: a price change keeps the option; new names are added; missing ones removed.
            stmts.push(sql`
              WITH gone AS (
                DELETE FROM disco_modifier_group_members gm USING disco_modifiers m
                 WHERE gm.group_reference = ${og.ref}::uuid AND m.reference = gm.modifier_reference AND NOT (m.name = ANY(${g.options.map(o => o.name)}::text[]))
                RETURNING gm.modifier_reference
              ) DELETE FROM disco_modifiers WHERE reference IN (SELECT modifier_reference FROM gone)
                  AND reference NOT IN (SELECT modifier_reference FROM disco_modifier_group_members WHERE group_reference <> ${og.ref}::uuid)`)
            g.options.forEach((o, oi) => {
              const had = og.options.find(x => x.name === o.name)
              if (had) {
                stmts.push(sql`UPDATE disco_modifiers m SET price = ${o.price}, position = ${oi}, updated_at = NOW() FROM disco_modifier_group_members gm
                               WHERE gm.group_reference = ${og.ref}::uuid AND gm.modifier_reference = m.reference AND m.name = ${o.name}`)
                stmts.push(sql`UPDATE disco_modifier_group_members gm SET position = ${oi} FROM disco_modifiers m
                               WHERE gm.group_reference = ${og.ref}::uuid AND gm.modifier_reference = m.reference AND m.name = ${o.name}`)
              } else {
                const mr = randomUUID()
                stmts.push(sql`INSERT INTO disco_modifiers (reference, restaurant_reference, name, price, visible, position) VALUES (${mr}::uuid, ${rest}::uuid, ${o.name}, ${o.price}, true, ${oi})`)
                stmts.push(sql`INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position) VALUES (${og.ref}::uuid, ${mr}::uuid, ${oi})`)
              }
            })
          }
        } else {
          // A new group, or a group other items share: this item gets its own copy so nothing else changes.
          const gr = randomUUID()
          stmts.push(...groupStmts(rest, after.name, it.name, g, gr, gi))
          stmts.push(sql`INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position) VALUES (${old.ref}::uuid, ${gr}::uuid, true, ${gi})`)
        }
      })
      for (const og of old.option_groups) if (!keptGroups.has(og.ref!)) {
        stmts.push(sql`DELETE FROM disco_item_groups WHERE item_reference = ${old.ref}::uuid AND group_reference = ${og.ref}::uuid`)
        stmts.push(...orphanGroupCleanup(og.ref!))
      }
    })
  })
  // Items and categories that are gone.
  for (const [ref, item] of bItems) if (!keptItems.has(ref)) {
    stmts.push(sql`DELETE FROM disco_item_groups WHERE item_reference = ${ref}::uuid`)
    for (const g of item.option_groups) stmts.push(...orphanGroupCleanup(g.ref!))
    stmts.push(sql`DELETE FROM disco_menu_items WHERE reference = ${ref}::uuid`)
  }
  for (const ref of bCats.keys()) if (!keptCats.has(ref)) stmts.push(sql`DELETE FROM disco_menu_categories WHERE reference = ${ref}::uuid AND menu_reference = ${plan.menuRef}::uuid`)
  await sql.transaction(stmts)
  return { changes: plan.changes.length }
}

/** Delete a group (and its options) once no item links to it. */
function orphanGroupCleanup(groupRef: string): Stmt[] {
  return [sql`
    WITH g AS (
      SELECT reference FROM disco_modifier_groups WHERE reference = ${groupRef}::uuid
        AND NOT EXISTS (SELECT 1 FROM disco_item_groups WHERE group_reference = ${groupRef}::uuid)
    ), m AS (
      DELETE FROM disco_modifier_group_members WHERE group_reference IN (SELECT reference FROM g) RETURNING modifier_reference
    ), dm AS (
      DELETE FROM disco_modifiers WHERE reference IN (SELECT modifier_reference FROM m)
        AND reference NOT IN (SELECT modifier_reference FROM disco_modifier_group_members WHERE group_reference <> ${groupRef}::uuid)
      RETURNING 1
    )
    DELETE FROM disco_modifier_groups WHERE reference IN (SELECT reference FROM g)`]
}
