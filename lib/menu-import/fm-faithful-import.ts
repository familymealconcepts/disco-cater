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
//   • GET /api/admin/restaurants/{ref}                   → restaurant.image (logo) + .marketplaceImage
//                                                          (hero). Both resolved to a direct, public,
//                                                          by-reference download URL via fmImageUrl()
//                                                          (../fm-image — the same helper the
//                                                          marketplace-image admin upload route uses),
//                                                          never re-hosted into Disco's own storage.
//
// Images are written ONLY when the target's icon_url/image_url are currently
// null — never overwritten. A restaurant can already have a real, independently-
// sourced image in Neon (e.g. uploaded directly through Disco's own portal,
// predating any conversion) that has nothing to do with FM's version; this import
// must never silently replace it.
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
import { fmImageUrl } from '../fm-image'

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
  // BOTH components, added — never one or the other.
  //
  // This previously read `feeType: pct != null ? 'PERCENT' : 'FIXED'` with
  // `feeValue: pct != null ? pct : fee`, i.e. percent-wins precedence that
  // silently DISCARDED FM's fixed component. It read both fields and threw one
  // away. All four Hugo's locations run "$20 + 10%" style zones in FM, so every
  // one of them imported as percent-only; order 900000094 collected $7.70 where
  // FM would have collected $37.70.
  //
  // Leaving this unfixed would reintroduce the bug on the next import, which is
  // why it ships with the schema change rather than after it.
  const tier = (fee: unknown, pct: unknown, radius: unknown) =>
    radius == null ? undefined : { radiusMiles: num(radius), feeFixed: num(fee), feePercent: num(pct) }
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
  iconUrlImported: boolean
  imageUrlImported: boolean
  // Items placed by the supplementary pass (below) — real FM items whose menu is
  // Inactive/hidden, invisible to the public per-menu endpoint the primary pass uses.
  // Includes items duplicated across multiple menus (see duplicatedAcrossMenus).
  supplementaryItemsPlaced: number
  // Of supplementaryItemsPlaced, how many were placed into MORE THAN ONE menu because
  // their schedule window matched more than one menu (e.g. twin party-size tiers with
  // an identical season window) — a real, faithful duplication, not an error.
  duplicatedAcrossMenus: number
  // Items that matched no menu by window, name, or tier heuristic at all — placed in
  // the first visible menu as a last resort so nothing is ever silently dropped, but
  // worth a human glance since placement wasn't confidently determined.
  unplacedFallbackCount: number
  error?: string
}

// Import a restaurant's FM menu faithfully into disco_* under targetRef (defaults to
// fmRef — same restaurant). Returns a summary. READ-ONLY against FM.
export async function importFmMenuFaithfully(fmRef: string, opts?: { targetRef?: string }): Promise<FaithfulImportSummary> {
  const targetRef = opts?.targetRef || fmRef
  const summary: FaithfulImportSummary = {
    fmRef, targetRef, menus: 0, categories: 0, items: 0, groups: 0, modifiers: 0, itemGroupLinks: 0, pricedModifiers: 0,
    announcementImported: false, deliveryWindowImported: false,
    iconUrlImported: false, imageUrlImported: false,
    supplementaryItemsPlaced: 0, duplicatedAcrossMenus: 0, unplacedFallbackCount: 0,
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

  // ── 0b) Restaurant images: logo (image) + marketplace/hero (marketplaceImage) ──
  // Fill-blank-only: check the CURRENT value first and only write a field that's
  // still null. Never overwrites an existing image, whatever its source — this is
  // the whole point (a restaurant can already have a real, independently-uploaded
  // image with nothing to do with FM's version).
  const fmRestaurant = await fmGet(`/api/admin/restaurants/${fmRef}`, auth) as { image?: unknown; marketplaceImage?: unknown } | null
  if (fmRestaurant) {
    const fmIconUrl = fmImageUrl(fmRestaurant.image)
    const fmImgUrl = fmImageUrl(fmRestaurant.marketplaceImage)
    if (fmIconUrl || fmImgUrl) {
      const current = (await sql`SELECT icon_url, image_url FROM disco_restaurant_cache WHERE restaurant_reference = ${targetRef}`) as { icon_url: string | null; image_url: string | null }[]
      const row = current[0]
      const setIcon = !!fmIconUrl && !row?.icon_url
      const setImage = !!fmImgUrl && !row?.image_url
      summary.iconUrlImported = setIcon
      summary.imageUrlImported = setImage
      if (setIcon || setImage) {
        await sql`
          UPDATE disco_restaurant_cache
          SET icon_url = COALESCE(icon_url, ${fmIconUrl}),
              image_url = COALESCE(image_url, ${fmImgUrl}),
              cached_at = NOW()
          WHERE restaurant_reference = ${targetRef}
        `
      }
    }
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
  // Only ever returns items for the menu(s) FM currently marks visible/active — by
  // design, this is a public/customer-facing endpoint and won't serve Inactive menu
  // content. `placedRefs` tracks every FM item reference placed here so the
  // supplementary pass below never double-imports them.
  let importedAnyItems = false
  const placedRefs = new Set<string>()
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
        placedRefs.add(str(pub.reference))
        importedAnyItems = true
      }
    }
  }

  // FALLBACK: if the public endpoint returned nothing for every menu (rare — a
  // restaurant whose only menu(s) are all currently invisible), use the flat catalog
  // as a whole-catalog substitute, placing each item in its own menu when known, else
  // the first VISIBLE menu (never a hidden/seasonal one, which is what the old
  // default-to-first bug did). Also marks placedRefs so the supplementary pass below
  // never re-processes these.
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
        placedRefs.add(str(it.reference))
      }
    }
  }

  // ── 4) Supplementary pass: real FM items belonging to Inactive/hidden menus ──
  // The public per-menu endpoint (step 3 PRIMARY) never surfaces Inactive-menu
  // content, so without this pass every Inactive menu silently imports with zero
  // items even though FM has real, current (non-archived) data for it. FM's flat
  // catalog has no usable item→menu link (`item.menu` is a bare literal, confirmed
  // identical across every item regardless of true menu — unusable), so placement is
  // reconstructed via the strongest available signals, in priority order:
  //   1. Exact match between the item's own scheduleOption window and a menu's own
  //      window.
  //   2. If MULTIPLE menus share an identical window (e.g. twin party-size tiers with
  //      the same season — confirmed real, not hypothetical), the item is placed into
  //      ALL of them. Duplicating is the faithful choice here, not an error: these are
  //      genuinely shared a-la-carte items FM makes available under both tiers, with
  //      nothing in the data distinguishing "belongs to tier A only."
  //   3. No window match at all (a stale per-item schedule stamp — e.g. last year's
  //      Super Bowl date still sitting on an item that's still part of the current
  //      catalog) → fall back to normalized category/menu NAME overlap.
  //   4. A narrow numeric party-size-tier heuristic for "under N people" / "N+" /
  //      "N or more" phrasing, common in catering party-size menus, matched against
  //      numeric ranges embedded in menu names (e.g. "12-29 people" / "30+ people").
  //   5. Still nothing → the first visible menu, so an item is never silently
  //      dropped even when every heuristic above misses — logged via
  //      unplacedFallbackCount rather than silently absorbed.
  const menuWindows = new Map<string, { start: string; end: string; name: string }>()
  for (const m of fmMenus) {
    const discoMenu = menuMap.get(str(m.reference)); if (!discoMenu) continue
    const sched = (m.scheduleOption || {}) as Record<string, unknown>
    menuWindows.set(discoMenu, { start: str(sched.startDate), end: str(sched.endDate), name: str(m.name) })
  }
  const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const tierNumbersInText = (s: string): { under?: number; atLeast?: number } => {
    const under = /under\s+(\d+)/i.exec(s)
    // Non-greedy, bounded gap so "30 ppl or more" / "30 people or more" still match —
    // catering party-size phrasing routinely has a word between the number and
    // "+"/"or more", not just adjacent digits.
    const atLeast = /(\d+)[^\d]{0,12}?(?:\+|or\s*more)/i.exec(s)
    return { under: under ? Number(under[1]) : undefined, atLeast: atLeast ? Number(atLeast[1]) : undefined }
  }
  const tierRangeInMenuName = (name: string): { lo?: number; hi?: number } => {
    const plus = /(\d+)\s*\+/.exec(name)
    if (plus) return { lo: Number(plus[1]) }
    const range = /(\d+)\s*-\s*(\d+)/.exec(name)
    if (range) return { lo: Number(range[1]), hi: Number(range[2]) }
    return {}
  }
  const catNameOf = (it: Record<string, unknown>): { name: string; description: string | null } => {
    const catObj = typeof it.itemCategory === 'object' && it.itemCategory ? (it.itemCategory as Record<string, unknown>) : null
    return { name: (catObj ? str(catObj.name) : str(it.itemCategory)) || 'Menu', description: catObj ? (str(catObj.description).trim() || null) : null }
  }

  const placeItem = async (it: Record<string, unknown>, targets: string[]) => {
    const { name: catName, description: catDescription } = catNameOf(it)
    const uniqueTargets = [...new Set(targets)]
    for (const discoMenu of uniqueTargets) {
      const catRef = await ensureCat(discoMenu, catName, catDescription)
      await insertItem(it, catRef)
    }
    summary.supplementaryItemsPlaced += uniqueTargets.length
    if (uniqueTargets.length > 1) summary.duplicatedAcrossMenus += uniqueTargets.length
  }

  // PASS A — exact window matches (steps 1/2). Also LEARNS which menu(s) each
  // category genuinely belongs to from these confidently-placed items, so pass B can
  // apply that same placement (including duplication across twin tiers) to sibling
  // items whose OWN schedule stamp is stale/missing but whose category is identical —
  // e.g. "Holiday Appetizers" items with a clean window match teach pass B where every
  // OTHER "Holiday Appetizers" item belongs too, rather than guessing per item.
  const categoryToMenus = new Map<string, Set<string>>()
  const unresolvedAfterA: Record<string, unknown>[] = []
  for (const it of fmItems) {
    const ref = str(it.reference)
    if (!ref || placedRefs.has(ref)) continue
    const sched = (it.scheduleOption || {}) as Record<string, unknown>
    const itemStart = str(sched.startDate), itemEnd = str(sched.endDate)
    const targets: string[] = []
    if (itemStart && itemEnd) {
      for (const [discoMenu, w] of menuWindows) {
        if (w.start === itemStart && w.end === itemEnd) targets.push(discoMenu)
      }
    }
    if (targets.length) {
      await placeItem(it, targets)
      const normCat = normalizeForMatch(catNameOf(it).name)
      if (!categoryToMenus.has(normCat)) categoryToMenus.set(normCat, new Set())
      for (const t of targets) categoryToMenus.get(normCat)!.add(t)
    } else {
      unresolvedAfterA.push(it)
    }
  }

  // PASS B — no window match. Priority: (3) this category's LEARNED placement from
  // pass A, so generic shared items (no tier-specific wording, e.g. "Vodka Sauce")
  // correctly duplicate the same way their sibling items already did; (4) normalized
  // category/menu NAME overlap (catches stale-window items still identifiable by
  // category, e.g. "Super Bowl Menu" category ↔ "Super Bowl"/"Superbowl Menu" menu,
  // when the category was never seen in pass A at all); (5) a narrow numeric
  // party-size-tier heuristic ("under N" / "N+" / "N or more") for the specific items
  // that ARE tier-labeled themselves; (6) last resort — first visible menu, logged via
  // unplacedFallbackCount rather than silently dropped.
  for (const it of unresolvedAfterA) {
    const { name: catName } = catNameOf(it)
    const normCat = normalizeForMatch(catName)
    let targets: string[] = []
    let wasFallback = false

    const learned = categoryToMenus.get(normCat)
    if (learned?.size) {
      targets = [...learned]
    }

    if (!targets.length && normCat) {
      for (const [discoMenu, w] of menuWindows) {
        const normMenu = normalizeForMatch(w.name)
        if (normMenu && (normCat.includes(normMenu) || normMenu.includes(normCat))) targets.push(discoMenu)
      }
    }

    if (!targets.length) {
      const tierText = `${str(it.name)} ${catName}`
      const t = tierNumbersInText(tierText)
      if (t.under != null || t.atLeast != null) {
        for (const [discoMenu, w] of menuWindows) {
          const r = tierRangeInMenuName(w.name)
          if (t.under != null && r.hi != null && r.hi < t.under) targets.push(discoMenu)
          else if (t.atLeast != null && r.lo != null && r.lo === t.atLeast && r.hi == null) targets.push(discoMenu)
        }
      }
    }

    if (!targets.length) {
      const visRef = fmMenus.find(m => m.visible !== false)?.reference
      const defaultMenu = (visRef ? menuMap.get(str(visRef)) : undefined) || (menuMap.values().next().value as string | undefined)
      if (defaultMenu) { targets = [defaultMenu]; wasFallback = true }
    }
    if (!targets.length) continue

    await placeItem(it, targets)
    if (wasFallback) summary.unplacedFallbackCount++
  }

  return summary
}
