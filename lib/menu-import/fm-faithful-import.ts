// Faithful FM → Disco-native migration importer.
//
// Unlike writeDiscoNativeMenu (which mirrors an AI-extracted upload and drops
// modifier prices/rules + all operational settings), this pulls a restaurant's REAL
// structured data from FM's live API and writes it faithfully into the Disco-native
// tables — so a converted restaurant keeps its actual menu, modifier prices, group
// rules, service charge, tips, delivery config, order minimums, and lead time.
//
// READ-ONLY against FM (all GETs). Sources (verified against live FM):
//   • GET /api/admin/menu?restaurantReference={ref}      → menus (+ REAL settings + scheduleOption;
//                                                          the non-admin /api/menu returns null settings)
//   • GET /api/restaurants/{ref}/extraItemsGroups        → modifier library (min/max + addOns w/ prices)
//   • GET /api/restaurants/{ref}/mealPackages            → items (+ itemCategory + attached group refs)
//
// maxOrder is NOT auto-imported: FM's scheduleOption.maxOrder is per-15-minute-window
// while Disco's max_orders_per_day is per-day (~96x different). It's left null
// (no cap) for an explicit manual admin decision (see the inventory item #4).
import { sql, runDiscoMenuMigrations } from '../db'
import { getFmServiceAuthHeader } from '../fm-service-auth'
import { parseMenuSettingsInput, parseDeliverySettings } from '../menu-settings'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const arrOf = (d: unknown): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d as Record<string, unknown>[]
  const o = d as { content?: unknown; data?: unknown } | null
  return (Array.isArray(o?.content) ? o!.content : Array.isArray(o?.data) ? o!.data : []) as Record<string, unknown>[]
}
async function fmGet(path: string, auth: Record<string, string>): Promise<unknown> {
  const r = await fetch(`${FM}${path}`, { headers: { ...auth, Accept: 'application/json' } })
  if (!r.ok) return null
  return r.json().catch(() => null)
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown): string => (v == null ? '' : String(v))
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)

// Add-on price: prefer FM's structured price; fall back to a price embedded in the
// name ("Gluten-Free Bread (+ $1.00)"), stripping it from the display name. Many FM
// add-ons are genuinely free (substitutions/choices) → price 0.
const NAME_PRICE = /\s*\(\s*\+?\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)\s*\)\s*$/
function addOnNamePrice(rawName: unknown, structuredPrice: unknown): { name: string; price: number } {
  const name = str(rawName) || 'Add-on'
  if (num(structuredPrice) > 0) return { name, price: num(structuredPrice) }
  const m = NAME_PRICE.exec(name)
  if (m) return { name: name.replace(NAME_PRICE, '').trim() || name, price: num(m[1]) }
  return { name, price: 0 }
}

// FM menu.settings + scheduleOption → the Disco settings body, then through the
// existing parsers (clamping/validation). maxOrdersPerDay intentionally null.
function fmMenuToDiscoSettings(settings: Record<string, unknown>, schedule: Record<string, unknown>) {
  const s = settings || {}, sc = schedule || {}
  const avail = Array.isArray(s.menuAvailability) ? (s.menuAvailability as unknown[]).map(x => str(x).toUpperCase()) : []
  const cutType = str(sc.cutOffType).toUpperCase()
  const tip = (s.tipOption || {}) as Record<string, unknown>
  const settingsBody: Record<string, unknown> = {
    offersPickup: avail.length === 0 || avail.includes('PICKUP'),
    offersDelivery: avail.length === 0 || avail.includes('DELIVERY'),
    serviceChargePct: num(s.serviceCharge),
    serviceChargeName: s.serviceChargeName ?? null,
    tipDefaultType: str(tip.tipsType || 'PERCENTAGE'),
    tipDefaultValue: num(tip.tipsPrice),
    pickupOrderMinimum: num(s.pickupOrderMinimum),
    deliveryOrderMinimum: num(s.deliveryOrderMinimum),
    maxOrdersPerDay: null, // MANUAL — never auto-convert FM's per-15-min maxOrder
    leadTimeHours: num(sc.prepTime) || 24,
    rollingAvailabilityDays: num(sc.rollingAvailability) || 90,
    dailyCutoffTime: cutType === 'DAILY' ? (str(sc.cutOff) || null) : null,
    hardCutoffDate: cutType === 'BY_DATE' ? (str(sc.cutOffDate) || null) : null,
  }
  const tier = (fee: unknown, pct: unknown, radius: unknown) =>
    radius == null ? undefined : { radiusMiles: num(radius), feeType: pct != null ? 'PERCENT' : 'FIXED', feeValue: num(pct != null ? pct : fee) }
  const method = str(s.deliveryType).toUpperCase() === 'OWN_DELIVERY' ? 'OWN_DELIVERY' : 'THIRD_PARTY'
  const deliveryBody = {
    deliverySettings: {
      method,
      own: method === 'OWN_DELIVERY'
        ? { primary: tier(s.ownDeliveryFee, s.ownDeliveryFeePercent, s.ownDeliveryRadius), secondary: tier(s.secondaryOwnDeliveryFee, s.secondaryOwnDeliveryFeePercent, s.secondaryOwnDeliveryRadius) }
        : undefined,
      thirdPartySubsidyPct: num(s.thirdPartyDeliverySubsidingPercent),
    },
  }
  return { menu: parseMenuSettingsInput(settingsBody), delivery: parseDeliverySettings(deliveryBody) }
}

export interface FaithfulImportSummary {
  fmRef: string; targetRef: string
  menus: number; categories: number; items: number; groups: number; modifiers: number; itemGroupLinks: number
  pricedModifiers: number; error?: string
}

// Import a restaurant's FM menu faithfully into disco_* under targetRef (defaults to
// fmRef — same restaurant). Returns a summary. READ-ONLY against FM.
export async function importFmMenuFaithfully(fmRef: string, opts?: { targetRef?: string }): Promise<FaithfulImportSummary> {
  const targetRef = opts?.targetRef || fmRef
  const summary: FaithfulImportSummary = { fmRef, targetRef, menus: 0, categories: 0, items: 0, groups: 0, modifiers: 0, itemGroupLinks: 0, pricedModifiers: 0 }
  await runDiscoMenuMigrations()
  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) { summary.error = `FM auth: ${e instanceof Error ? e.message : e}`; return summary }

  // /api/admin/menu is the authoritative admin configuration: it carries the REAL
  // menu.settings/scheduleOption (service charge, tips, order minimums, prep time),
  // whereas the customer /api/menu returns null settings. NOTE (FM quirk): the two
  // endpoints are actually DIFFERENT menu objects — different reference, name, and
  // `type` (admin "Catering Menu"/GENERAL_CATERING vs customer "Catering"/
  // OFFICE_CATERING) with no shared key to reconcile — so the import uses the admin
  // representation throughout (name + type + settings) rather than fragilely zipping.
  const fmMenus = arrOf(await fmGet(`/api/admin/menu?restaurantReference=${fmRef}&page=0&size=100`, auth))
  const fmGroups = arrOf(await fmGet(`/api/restaurants/${fmRef}/extraItemsGroups?page=0&size=500`, auth))
  const fmItems = arrOf(await fmGet(`/api/restaurants/${fmRef}/mealPackages?page=0&size=1000`, auth))
  if (!fmMenus.length && !fmItems.length) { summary.error = 'No FM menu/items returned'; return summary }

  // ── 1) Modifier library: groups (real min/max + external names) + modifiers (real prices) ──
  const groupMap = new Map<string, string>() // fm group ref → disco group ref
  let gpos = 0
  for (const g of fmGroups) {
    const gRef = str(g.reference); if (!gRef) continue
    const min = Math.max(0, Math.trunc(num(g.minSelectedItems)))
    const max = Math.max(1, Math.trunc(num(g.maxSelectedItems) || 1))
    const gi = (await sql`
      INSERT INTO disco_modifier_groups (restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, position)
      VALUES (${targetRef}::uuid, ${str(g.name) || 'Group'}, ${str(g.externalName) || str(g.name) || null}, ${str(g.subExternalName) || null}, ${min}, ${max}, ${gpos++})
      RETURNING reference
    `) as { reference: string }[]
    const discoGroup = gi[0].reference
    groupMap.set(gRef, discoGroup)
    summary.groups++
    let mpos = 0
    for (const a of arrOf(g.addOns)) {
      const { name, price } = addOnNamePrice(a.name, a.price)
      const mi = (await sql`INSERT INTO disco_modifiers (restaurant_reference, name, price, position) VALUES (${targetRef}::uuid, ${name}, ${price}, ${mpos}) RETURNING reference`) as { reference: string }[]
      await sql`INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position) VALUES (${discoGroup}::uuid, ${mi[0].reference}::uuid, ${mpos})`
      summary.modifiers++; if (price > 0) summary.pricedModifiers++
      mpos++
    }
  }

  // ── 2) Menus (with faithful operational settings) ──
  const menuMap = new Map<string, string>() // fm menu ref → disco menu ref
  let menuPos = 0
  for (const m of fmMenus) {
    const mRef = str(m.reference); if (!mRef) continue
    const { menu: ms, delivery } = fmMenuToDiscoSettings((m.settings || {}) as Record<string, unknown>, (m.scheduleOption || {}) as Record<string, unknown>)
    const nm = str(m.name) || 'Menu'
    const mi = (await sql`
      INSERT INTO disco_menus (
        restaurant_reference, name, url, type, description, visible,
        offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
        tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
        max_orders_per_day, lead_time_hours, rolling_availability_days, daily_cutoff_time, hard_cutoff_date,
        delivery_settings, position)
      VALUES (
        ${targetRef}::uuid, ${nm}, ${(slugify(nm) || 'menu') + '-' + menuPos}, ${str(m.type) || 'GENERAL_CATERING'}, ${str(m.description) || null}, ${m.visible !== false},
        ${ms.offersPickup}, ${ms.offersDelivery}, ${ms.serviceChargePct}, ${ms.serviceChargeName},
        ${ms.tipDefaultType}, ${ms.tipDefaultValue}, ${ms.pickupOrderMinimum}, ${ms.deliveryOrderMinimum},
        ${ms.maxOrdersPerDay}, ${ms.leadTimeHours}, ${ms.rollingAvailabilityDays}, ${ms.dailyCutoffTime}::time, ${ms.hardCutoffDate}::date,
        ${delivery ? JSON.stringify(delivery) : null}::jsonb, ${menuPos++})
      RETURNING reference
    `) as { reference: string }[]
    menuMap.set(mRef, mi[0].reference)
    summary.menus++
  }
  const defaultMenu = menuMap.values().next().value as string | undefined

  // ── 3) Items → categories (menu-scoped, find-or-create) + item rows + group links ──
  const catCache = new Map<string, string>() // `${menuRef}::${catName}` → cat ref
  let itemPos = 0
  for (const it of fmItems) {
    const fmMenuRef = str((it.menu as Record<string, unknown> | undefined)?.reference)
    const discoMenu = menuMap.get(fmMenuRef) || defaultMenu
    if (!discoMenu) continue
    const catName = (typeof it.itemCategory === 'object' && it.itemCategory ? str((it.itemCategory as Record<string, unknown>).name) : str(it.itemCategory)) || 'Menu'
    const catKey = `${discoMenu}::${catName}`
    let catRef = catCache.get(catKey)
    if (!catRef) {
      const found = (await sql`SELECT reference FROM disco_menu_categories WHERE restaurant_reference = ${targetRef}::uuid AND menu_reference = ${discoMenu}::uuid AND name = ${catName} LIMIT 1`) as { reference: string }[]
      catRef = found[0]?.reference
      if (!catRef) {
        const cp = (await sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM disco_menu_categories WHERE menu_reference = ${discoMenu}::uuid`) as { p: number }[]
        const ci = (await sql`INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name, position) VALUES (${targetRef}::uuid, ${discoMenu}::uuid, ${catName}, ${cp[0]?.p ?? 0}) RETURNING reference`) as { reference: string }[]
        catRef = ci[0].reference
        summary.categories++
      }
      catCache.set(catKey, catRef)
    }
    const serves = str(it.serves).trim() || null
    const displayPrice = str(it.displayPrice).trim().slice(0, 120) || null
    const minQty = num(it.minQuantity) > 0 ? Math.round(num(it.minQuantity)) : null
    const ii = (await sql`
      INSERT INTO disco_menu_items (restaurant_reference, category_reference, name, description, price, serves, display_price, min_quantity, allow_special_instructions, visible, position)
      VALUES (${targetRef}::uuid, ${catRef}::uuid, ${str(it.name) || 'Item'}, ${str(it.description) || null}, ${num(it.price)}, ${serves}, ${displayPrice}, ${minQty}, ${it.allowedSpecialInstructions === true}, ${it.visible !== false}, ${itemPos++})
      RETURNING reference
    `) as { reference: string }[]
    const itemRef = ii[0].reference
    summary.items++
    // Attach the item's modifier groups (map FM group ref → imported disco group ref).
    let lpos = 0
    for (const eg of arrOf(it.extraItemsGroups)) {
      const discoGroup = groupMap.get(str(eg.reference))
      if (!discoGroup) continue
      await sql`INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position) VALUES (${itemRef}::uuid, ${discoGroup}::uuid, ${eg.enabled !== false}, ${lpos++}) ON CONFLICT (item_reference, group_reference) DO NOTHING`
      summary.itemGroupLinks++
    }
  }

  return summary
}
