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

  // 8. Operating settings (disco_restaurant_overrides).
  //
  // This was missing entirely, so a duplicated native restaurant had NO overrides
  // row at all — not an empty one, none — and with no tax config its checkout
  // refuses every order. Both existing native copies are in that state.
  //
  // DELIBERATELY NOT COPIED:
  //   • stripe_account_id (and the stripe_* status columns). A duplicate must
  //     never inherit another restaurant's payout destination — that would route
  //     one restaurant's money into another's account. The duplicate starts with
  //     no connected account and onboards its own.
  //   • promo codes. They live in their own table and duplicating live discount
  //     codes is not wanted.
  //   • money_flow. Payout-adjacent; left at the column default rather than
  //     inherited on a guess.
  // visible is forced FALSE: a duplicate is a draft, never silently listed.
  const src = (await sql`
    SELECT tax_rates, notification_emails, notification_sms_numbers, text_notifications_enabled,
           order_reminder_emails_enabled, admin_order_reminder_emails_enabled,
           lead_gen_one_pct, lead_gen_two_pct, online_ordering_enabled
    FROM disco_restaurant_overrides WHERE restaurant_reference = ${sourceRef}::uuid LIMIT 1
  `) as Record<string, unknown>[]
  const ov = src[0]
  await sql`
    INSERT INTO disco_restaurant_overrides (
      restaurant_reference, visible, tax_rates, notification_emails, notification_sms_numbers,
      text_notifications_enabled, order_reminder_emails_enabled, admin_order_reminder_emails_enabled,
      lead_gen_one_pct, lead_gen_two_pct, online_ordering_enabled
    ) VALUES (
      ${newRef}::uuid, false,
      ${ov?.tax_rates ? JSON.stringify(ov.tax_rates) : null}::jsonb,
      ${(ov?.notification_emails as string) ?? null},
      ${(ov?.notification_sms_numbers as string) ?? null},
      ${(ov?.text_notifications_enabled as boolean) ?? null},
      ${(ov?.order_reminder_emails_enabled as boolean) ?? null},
      ${(ov?.admin_order_reminder_emails_enabled as boolean) ?? null},
      ${(ov?.lead_gen_one_pct as string) ?? null},
      ${(ov?.lead_gen_two_pct as string) ?? null},
      ${(ov?.online_ordering_enabled as boolean) ?? null}
    )
    ON CONFLICT (restaurant_reference) DO NOTHING
  `

  // 9. Restaurant-wide closed days / holidays
  const closed = (await sql`SELECT name, holiday, from_date, to_date FROM disco_restaurant_closed_days WHERE restaurant_reference = ${sourceRef}::uuid`) as Record<string, unknown>[]
  for (const cd of closed) {
    await sql`INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, holiday, from_date, to_date) VALUES (${newRef}::uuid, ${cd.name}, ${cd.holiday}, ${cd.from_date}, ${cd.to_date})`
  }
}

/**
 * Copy the source restaurant's OPERATIONAL SETTINGS row into the clone.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 * cloneDiscoRestaurantMenus copies the menu tree faithfully and nothing else, so
 * a native duplicate was created with NO disco_restaurant_overrides ROW AT ALL.
 * Verified on both existing native copies (Tom Toms Italian (Copy), Apollo Bagels
 * - Kips Bay (Copy)): full menu trees, zero overrides rows.
 *
 * The practical consequence is that the duplicate CANNOT TAKE AN ORDER. Checkout
 * reads tax through lib/pricing/tax-config.ts, and with no row there is no
 * tax_rates at all — not a 0% rate, which is a real and valid answer, but the
 * absence of an answer — so the order is refused. A duplicate that looks complete
 * in the portal and silently cannot transact is worse than one that is obviously
 * unfinished.
 *
 * ── WHAT IS DELIBERATELY NOT COPIED ───────────────────────────────────────────
 * stripe_account_id AND stripe_onboarding_complete. A duplicate must never
 * inherit another restaurant's payout destination: that would route one
 * restaurant's money into another restaurant's bank account, which is the single
 * most damaging thing this function could do. The clone starts with no payment
 * destination and is not orderable until someone attaches its own — which is the
 * correct, visible, blocking state rather than a silent misdirection.
 *
 * Promo codes are not copied either (they live in their own table and are a
 * marketing decision, not a setting), and `visible` is forced to false so a
 * half-configured duplicate can never appear on the marketplace on its own.
 *
 * Everything carried is a SETTING the operator would otherwise retype: tax
 * rates, who gets notified, the lead-gen percentages, and whether online
 * ordering is on.
 */
export async function cloneDiscoRestaurantOverrides(sourceRef: string, newRef: string): Promise<boolean> {
  const rows = (await sql`
    SELECT tax_rates, notification_emails, notification_sms_numbers,
           order_reminder_emails_enabled, admin_order_reminder_emails_enabled,
           text_notifications_enabled, lead_gen_one_pct, lead_gen_two_pct,
           online_ordering_enabled, delivery_order_time_windows, enable_menu_search,
           nash_allowed, shipday_enabled, money_flow
      FROM disco_restaurant_overrides WHERE restaurant_reference = ${sourceRef} LIMIT 1
  `) as Record<string, unknown>[]

  // No source row is not an error — plenty of restaurants have none — but the
  // clone still needs a row so it is configurable, so insert the defaults.
  const s = rows[0] ?? {}

  await sql`
    INSERT INTO disco_restaurant_overrides (
      restaurant_reference, visible,
      tax_rates, notification_emails, notification_sms_numbers,
      order_reminder_emails_enabled, admin_order_reminder_emails_enabled,
      text_notifications_enabled, lead_gen_one_pct, lead_gen_two_pct,
      online_ordering_enabled, delivery_order_time_windows, enable_menu_search,
      nash_allowed, shipday_enabled, money_flow
      -- stripe_account_id / stripe_onboarding_complete intentionally absent; see header.
    ) VALUES (
      ${newRef}, false,
      ${s.tax_rates ? JSON.stringify(s.tax_rates) : null}::jsonb,
      ${(s.notification_emails as string) ?? null},
      ${(s.notification_sms_numbers as string) ?? null},
      ${(s.order_reminder_emails_enabled as boolean) ?? null},
      ${(s.admin_order_reminder_emails_enabled as boolean) ?? null},
      ${(s.text_notifications_enabled as boolean) ?? null},
      ${(s.lead_gen_one_pct as string) ?? null},
      ${(s.lead_gen_two_pct as string) ?? null},
      ${(s.online_ordering_enabled as boolean) ?? null},
      ${(s.delivery_order_time_windows as string) ?? null},
      ${(s.enable_menu_search as boolean) ?? null},
      ${(s.nash_allowed as boolean) ?? null},
      ${(s.shipday_enabled as boolean) ?? null},
      ${(s.money_flow as string) ?? null}
    )
    ON CONFLICT (restaurant_reference) DO NOTHING
  `
  return rows.length > 0
}
