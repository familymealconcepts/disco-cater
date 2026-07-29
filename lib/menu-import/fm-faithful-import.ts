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
//   • GET /api/restaurants/{ref}/mealPackages            → FLAT item catalog (richer per-item fields:
//                                                          visible, displayPrice, minQuantity, addOns)
//   • GET /public-api/restaurants/{ref}/mealPackages?menuReference={menu}
//                                                        → each MENU's real categories (nested
//                                                          mealPackages) — the only source that
//                                                          partitions items per menu (the flat
//                                                          catalog's item.menu is a bare number, not
//                                                          a ref, so it can't place items in menus).
//   • GET /public-api/restaurants/{ref}/feesAndTips      → announcement + deliveryOrderTimeWindows.
//                                                          PUBLIC (permitAll in FM's WebSecurityConfig,
//                                                          no auth needed) — deliberately NOT the
//                                                          session-scoped GET /api/feesAndTips (that
//                                                          one resolves "current restaurant" from the
//                                                          authenticated JWT's own user id and has no
//                                                          by-reference variant, so a service-account
//                                                          importer can never reach an arbitrary
//                                                          restaurant's settings through it).
//
// maxOrder is NOT auto-imported: FM's scheduleOption.maxOrder is per-15-minute-window
// while Disco's max_orders_per_day is per-day (~96x different). It's left null
// (no cap) for an explicit manual admin decision (see the inventory item #4).
//
// NOT imported, and cannot be with any FM endpoint found: email/text notification
// recipients. FM's tbl_notification_settings is exposed only via GET /api/notifications
// (session-scoped, same "current restaurant from the authenticated user" limitation as
// the old /api/feesAndTips call, but unlike feesAndTips it has no public by-reference
// mirror anywhere in the FM backend). Reaching it would require impersonating that
// restaurant's own admin login, which Disco never stores credentials for — this is a
// real access-control wall, not a missed function call. Flagging, not working around.
//
// Per-item schedule overrides (ScheduleOption.isRestaurantDefault = false on an
// individual meal package) are intentionally NOT imported. Disco-native has no
// per-item scheduling concept at all — confirmed no UI, no disco_menu_items
// column, and no code path anywhere reads/writes one (per-item schedule override
// was investigated as a feature to build here and confirmed to not exist and not
// be needed; schedule is exclusively menu-level). Only the MENU-level
// scheduleOption.repeatWeekDays is imported (see fmScheduleToDiscoConfig) — this
// is not a partial import, it's the complete, correct scope.
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

// "H:MM:SS" or "HH:MM:SS" (FM sends both inconsistently — menu-level scheduleOption
// omits the leading zero, item-level scheduleOption includes it) → Disco's "HH:mm".
function normalizeTime(t: unknown): string {
  const s = str(t)
  const m = /^(\d{1,2}):(\d{2})/.exec(s)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : s
}

// FM's scheduleOption.repeatWeekDays (real per-day pickup/delivery windows) →
// Disco-native's disco_menus.schedule_config shape (NativeScheduleConfig in
// lib/scheduling/native-schedule.ts). Faithful: populates every day FM actually
// listed with its real window, not just a single averaged window. scheduleType
// mirrors FM's own SAME_DAY/CUSTOM distinction — CUSTOM only when the windows
// genuinely differ across days (or FM itself already says CUSTOM).
export function fmScheduleToDiscoConfig(schedule: Record<string, unknown>): Record<string, unknown> | null {
  const repeatWeekDays = arrOf(schedule?.repeatWeekDays) as { fromPickUpTime?: unknown; toPickUpTime?: unknown; days?: unknown }[]
  if (!repeatWeekDays.length) return null
  const days: string[] = []
  const perDay: Record<string, { from: string; to: string }> = {}
  for (const rd of repeatWeekDays) {
    const day = str(rd.days).toUpperCase()
    if (!day) continue
    const win = { from: normalizeTime(rd.fromPickUpTime), to: normalizeTime(rd.toPickUpTime) }
    days.push(day)
    perDay[day] = win
  }
  if (!days.length) return null
  const windows = new Set(days.map(d => `${perDay[d].from}-${perDay[d].to}`))
  const scheduleType = windows.size === 1 && str(schedule?.scheduleType).toUpperCase() !== 'CUSTOM' ? 'SAME_DAY' : 'CUSTOM'
  return { scheduleType, days, sameWindow: perDay[days[0]], perDay }
}

export const DELIVERY_WINDOWS = new Set(['exact', '30_min', '1_hour'])

export interface FaithfulImportSummary {
  fmRef: string; targetRef: string
  menus: number; categories: number; items: number; groups: number; modifiers: number; itemGroupLinks: number
  pricedModifiers: number
  announcementImported: boolean
  deliveryWindowImported: boolean
  error?: string
}

// Import a restaurant's FM menu faithfully into disco_* under targetRef (defaults to
// fmRef — same restaurant). Returns a summary. READ-ONLY against FM.
export async function importFmMenuFaithfully(fmRef: string, opts?: { targetRef?: string }): Promise<FaithfulImportSummary> {
  const targetRef = opts?.targetRef || fmRef
  const summary: FaithfulImportSummary = {
    fmRef, targetRef, menus: 0, categories: 0, items: 0, groups: 0, modifiers: 0, itemGroupLinks: 0, pricedModifiers: 0,
    announcementImported: false, deliveryWindowImported: false,
  }
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

  // ── 0) Restaurant-level settings: announcement + delivery order time window ──
  // Public endpoint, no auth needed (see the file-header note on why the
  // session-scoped /api/feesAndTips can't be used here).
  const feesAndTips = await fmGet(`/public-api/restaurants/${fmRef}/feesAndTips`, {}) as { announcement?: unknown; deliveryOrderTimeWindows?: unknown } | null
  if (feesAndTips) {
    const announcement = str(feesAndTips.announcement).trim().slice(0, 500) || null
    const rawWindow = str(feesAndTips.deliveryOrderTimeWindows)
    const deliveryWindow = DELIVERY_WINDOWS.has(rawWindow) ? rawWindow : 'exact'
    summary.announcementImported = announcement != null
    summary.deliveryWindowImported = DELIVERY_WINDOWS.has(rawWindow)
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, announcement, delivery_order_time_windows, updated_at)
      VALUES (${targetRef}, ${announcement}, ${deliveryWindow}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET
        announcement = EXCLUDED.announcement,
        delivery_order_time_windows = EXCLUDED.delivery_order_time_windows,
        updated_at = NOW()
    `
  }

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
    const scheduleObj = (m.scheduleOption || {}) as Record<string, unknown>
    const { menu: ms, delivery } = fmMenuToDiscoSettings((m.settings || {}) as Record<string, unknown>, scheduleObj)
    const scheduleConfig = fmScheduleToDiscoConfig(scheduleObj)
    const nm = str(m.name) || 'Menu'
    const mi = (await sql`
      INSERT INTO disco_menus (
        restaurant_reference, name, url, type, description, visible,
        offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
        tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
        max_orders_per_day, lead_time_hours, rolling_availability_days, daily_cutoff_time, hard_cutoff_date,
        delivery_settings, schedule_config, position)
      VALUES (
        ${targetRef}::uuid, ${nm}, ${(slugify(nm) || 'menu') + '-' + menuPos}, ${str(m.type) || 'GENERAL_CATERING'}, ${str(m.description) || null}, ${m.visible !== false},
        ${ms.offersPickup}, ${ms.offersDelivery}, ${ms.serviceChargePct}, ${ms.serviceChargeName},
        ${ms.tipDefaultType}, ${ms.tipDefaultValue}, ${ms.pickupOrderMinimum}, ${ms.deliveryOrderMinimum},
        ${ms.maxOrdersPerDay}, ${ms.leadTimeHours}, ${ms.rollingAvailabilityDays}, ${ms.dailyCutoffTime}::time, ${ms.hardCutoffDate}::date,
        ${delivery ? JSON.stringify(delivery) : null}::jsonb, ${scheduleConfig ? JSON.stringify(scheduleConfig) : null}::jsonb, ${menuPos++})
      RETURNING reference
    `) as { reference: string }[]
    menuMap.set(mRef, mi[0].reference)
    summary.menus++
  }
  // ── 3) Items → categories, scoped per menu ──
  // The flat /api/.../mealPackages catalog has NO usable menu linkage (item.menu is a
  // bare number, not a ref), so importing from it alone would dump every item into a
  // single menu. The customer site partitions items via the PUBLIC per-menu endpoint,
  // which returns each menu's real categories (with nested mealPackages). We traverse
  // menus through it for the correct menu→category→item structure, enriching each
  // item's richer fields (visible, displayPrice, minQuantity, addOns) from the flat
  // catalog joined by reference.
  const flatByRef = new Map<string, Record<string, unknown>>()
  for (const it of fmItems) { const r = str(it.reference); if (r) flatByRef.set(r, it) }
  const catCache = new Map<string, string>() // `${discoMenu}::${catName}` → cat ref
  let itemPos = 0

  const ensureCat = async (discoMenu: string, catName: string, catDescription: string | null = null): Promise<string> => {
    const catKey = `${discoMenu}::${catName}`
    const cached = catCache.get(catKey)
    if (cached) return cached
    const found = (await sql`SELECT reference FROM disco_menu_categories WHERE restaurant_reference = ${targetRef}::uuid AND menu_reference = ${discoMenu}::uuid AND name = ${catName} LIMIT 1`) as { reference: string }[]
    let catRef = found[0]?.reference
    if (!catRef) {
      const cp = (await sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM disco_menu_categories WHERE menu_reference = ${discoMenu}::uuid`) as { p: number }[]
      const ci = (await sql`INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name, description, position) VALUES (${targetRef}::uuid, ${discoMenu}::uuid, ${catName}, ${catDescription}, ${cp[0]?.p ?? 0}) RETURNING reference`) as { reference: string }[]
      catRef = ci[0].reference
      summary.categories++
    }
    catCache.set(catKey, catRef)
    return catRef
  }

  const insertItem = async (it: Record<string, unknown>, catRef: string): Promise<void> => {
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

  // PRIMARY: public per-menu traversal → correct menu→category→item partition.
  let importedAnyItems = false
  for (const m of fmMenus) {
    const discoMenu = menuMap.get(str(m.reference))
    if (!discoMenu) continue
    const cats = arrOf(await fmGet(`/public-api/restaurants/${fmRef}/mealPackages?menuReference=${str(m.reference)}`, auth))
    for (const c of cats) {
      const pkgs = arrOf(c.mealPackages)
      if (!pkgs.length) continue
      const catRef = await ensureCat(discoMenu, str(c.name) || 'Menu', str(c.description).trim() || null)
      for (const pub of pkgs) {
        // Flat catalog fills the fields the public endpoint omits; public is the
        // menu-scoped truth for the rest (name/price/serves/extraItemsGroups).
        const flat = flatByRef.get(str(pub.reference)) || {}
        await insertItem({ ...flat, ...pub }, catRef)
        importedAnyItems = true
      }
    }
  }

  // FALLBACK: if the public endpoint returned nothing for every menu, use the flat
  // catalog — placing each item in its own menu when known, else the first VISIBLE
  // menu (never a hidden/seasonal one, which is what the old default-to-first bug did).
  if (!importedAnyItems) {
    const visRef = fmMenus.find(m => m.visible !== false)?.reference
    const defaultMenu = (visRef ? menuMap.get(str(visRef)) : undefined) || (menuMap.values().next().value as string | undefined)
    if (defaultMenu) {
      for (const it of fmItems) {
        const discoMenu = menuMap.get(str((it.menu as Record<string, unknown> | undefined)?.reference)) || defaultMenu
        const catObj = typeof it.itemCategory === 'object' && it.itemCategory ? (it.itemCategory as Record<string, unknown>) : null
        const catName = (catObj ? str(catObj.name) : str(it.itemCategory)) || 'Menu'
        const catDescription = catObj ? (str(catObj.description).trim() || null) : null
        const catRef = await ensureCat(discoMenu, catName, catDescription)
        await insertItem(it, catRef)
      }
    }
  }

  return summary
}
