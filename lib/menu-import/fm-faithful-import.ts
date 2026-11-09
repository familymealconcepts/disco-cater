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
//   • GET /api/restaurants/{ref}/mealPackages            → FLAT item catalog, hidden items included
//                                                          (visible, displayPrice, minQuantity, addOns,
//                                                          itemCategory.reference). All three lists are
//                                                          paged with sort=id,asc — see fmGetAll.
//   • GET /api/itemCategories?menuReference={menu}       → EVERY category of a menu, hidden ones too —
//                                                          the category → menu link that places each
//                                                          item on exactly the menu FM has it on.
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
// Restaurant-level images are written ONLY when the target's icon_url/image_url are
// currently null — never overwritten. A restaurant can already have a real,
// independently-sourced image in Neon (e.g. uploaded directly through Disco's own
// portal, predating any conversion) that has nothing to do with FM's version; this
// import must never silently replace it.
//
// PER-ITEM images ARE re-hosted, unlike the two restaurant-level ones above. They
// come from each mealPackage's `image.reference` and are downloaded once and stored
// in Vercel Blob (./fm-item-images), so ~600 item rows don't end up resolving through
// api.familymeal.com at render time on a system being sunset. Best-effort per item: a
// failure leaves image_url NULL and is picked up by re-running
// scripts/backfill-item-images-from-fm.ts. The restaurant-level pair keeping FM URLs
// is the same latent dependency at restaurant scale and wants the same treatment —
// not changed here, flagged in ./fm-item-images.
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
import { parseMenuSettingsInput, parseDeliverySettings, toHHMM, type SkippedDay } from '../menu-settings'
import { fmImageUrl } from '../fm-image'
import { resolveFmItemImage, fmItemImageReference, fmItemImageStorageKey, newItemImageCache } from './fm-item-images'

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
// Every page of a paged FM list, or null if any page fails.
//
// THE SORT IS REQUIRED. Unsorted, FM's pages come back in no stable order, so
// consecutive pages overlap and skip rows: Colonial Ranch Market's 1,112 items
// paged 200 at a time returned 1,060 distinct items. With sort=id,asc all 1,112
// arrived. The old single page of size=1000 also cut every larger catalogue off
// at 1,000. A response that is not a page (a plain array) is returned as is.
async function fmGetAll(path: string, auth: Record<string, string>): Promise<Record<string, unknown>[] | null> {
  const out: Record<string, unknown>[] = []
  for (let page = 0; ; page++) {
    const d = await fmGet(`${path}${path.includes('?') ? '&' : '?'}page=${page}&size=500&sort=id,asc`, auth) as { content?: unknown; totalPages?: unknown } | unknown[] | null
    if (d == null) return null
    if (Array.isArray(d)) return d as Record<string, unknown>[]
    out.push(...arrOf(d))
    if (page + 1 >= num(d.totalPages)) return out
  }
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
    // NULL CHECKS, NOT FALSY CHECKS. These were `num(...) || <default>`, which
    // cannot tell "FM said 0" from "FM said nothing" — so a restaurant that
    // accepts same-day orders (prepTime 0) was silently given a 24-HOUR lead
    // time. All five Beach Buns seasonal menus are in that state today.
    // The rollingAvailability default is 30, matching MenuScheduleOption's own
    // field initialiser (`private Integer rollingAvailability = 30`); the old 90
    // was three times FM's window, invented here.
    leadTimeHours: sc.prepTime != null ? num(sc.prepTime) : 24,
    rollingAvailabilityDays: sc.rollingAvailability != null ? num(sc.rollingAvailability) : 30,
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

/**
 * FM's scheduleOption.skippedDays → Disco's disco_menus.skipped_days.
 *
 * NOT A STRAIGHT COPY, because the two shapes are NOT equivalent and copying
 * naively makes Disco refuse orders FM accepts.
 *
 * FM's SkippedDay is { name, intervals: TimeInterval[], fromDate, toDate }, and
 * Disco's now matches it field for field — { name?, fromDate, toDate, intervals? }.
 * It did NOT used to: Disco had no intervals concept, so every skip blocked the
 * whole day, and this function DROPPED interval-bearing entries rather than
 * over-block. That was the right call against the alternative but it under-blocked
 * instead: at Bird & Co. it discarded 11 partial windows, 8 of which were still
 * bookable in Disco when this was fixed (2026-08-28), while FM refused them.
 *
 * FM only blocks a DATE when the skip has NO intervals. From
 * MealPackageServiceImpl.getMenuSkippedDates, verbatim:
 *
 *     .filter(sd -> nonNull(sd.getFromDate()) && nonNull(sd.getToDate())
 *                   && CollectionUtils.isEmpty(sd.getIntervals()))
 *     .flatMap(sd -> sd.getFromDate().datesUntil(sd.getToDate().plusDays(1)))
 *
 * So an interval-bearing skip ("Christmas Eve, closed 15:00–22:00") narrows the
 * ordering WINDOW in FM and leaves the date orderable. Importing it as a Disco
 * skip would black out the whole day instead. Across the converted restaurants
 * that is not a corner case: 47 of 71 FM entries carry intervals, so a naive
 * copy would have blocked 47 dates FM allows.
 *
 * Both shapes are now carried. FM's times arrive as LocalTime "H:mm:ss" with a
 * SINGLE-DIGIT hour ("9:00:00", "0:45:00") and are normalized to "HH:mm" via
 * toHHMM — a naive slice(0,5) yields "0:45" and silently fails validation.
 *
 * Enforcement is inclusive on BOTH ends, matching FM exactly; see
 * lib/scheduling/cutoffs.ts's inBlockedInterval for the measurement that
 * established it against FM's own availablePickUp.
 *
 * droppedWithIntervals survives for one narrow case only: FM sent intervals but
 * none survived normalization. Storing such an entry with no intervals would turn
 * a partial block into a whole-day one, so it is reported rather than guessed at.
 *
 * Range semantics DO match: FM's datesUntil(toDate.plusDays(1)) is inclusive of
 * both endpoints, and Disco's skippedDateSet() walks `cur <= end`. No off-by-one.
 */
export function fmSkippedDaysToDisco(schedule: Record<string, unknown>): {
  skippedDays: SkippedDay[]
  droppedWithIntervals: { name: string; fromDate: string; toDate: string; intervals: number }[]
  partialImported: number
} {
  const raw = arrOf(schedule?.skippedDays) as Record<string, unknown>[]
  const skippedDays: SkippedDay[] = []
  const droppedWithIntervals: { name: string; fromDate: string; toDate: string; intervals: number }[] = []
  let partialImported = 0
  for (const sd of raw) {
    const fromDate = str(sd.fromDate), toDate = str(sd.toDate)
    if (!fromDate || !toDate) continue // FM ignores a half-specified range too
    const name = str(sd.name)
    const rawIntervals = arrOf(sd.intervals)
    const intervals: { fromTime: string; toTime: string }[] = []
    for (const iv of rawIntervals) {
      const fromTime = toHHMM(iv?.fromTime), toTime = toHHMM(iv?.toTime)
      if (!fromTime || !toTime || fromTime >= toTime) continue
      intervals.push({ fromTime, toTime })
    }
    // FM sent intervals but none survived normalization (malformed times, or a
    // zero-width range). Importing the entry as a WHOLE-DAY block would over-block
    // a date FM leaves open, so report it instead of guessing — this is the only
    // remaining path to droppedWithIntervals.
    if (rawIntervals.length && !intervals.length) {
      droppedWithIntervals.push({ name, fromDate, toDate, intervals: rawIntervals.length })
      continue
    }
    if (intervals.length) partialImported++
    skippedDays.push({ ...(name ? { name } : {}), fromDate, toDate, ...(intervals.length ? { intervals } : {}) })
  }
  return { skippedDays, droppedWithIntervals, partialImported }
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
  /**
   * FM items whose category is on none of the restaurant's menus (FM's own data:
   * a category detached from its menu). Not imported, and named so a human can
   * decide; the old importer guessed a menu for these and put them in it.
   */
  unplacedItems: { name: string; category: string }[]
  // Items skipped because their FM category is hidden (ItemCategory.visible =
  // false). They would not show on FM's storefront either.
  hiddenCategorySkipped: number
  // Blackout ranges carried across from FM's scheduleOption.skippedDays.
  skippedDayRangesImported: number
  // Of skippedDayRangesImported, how many are PARTIAL-day (carry time intervals)
  // rather than whole-day blocks. Disco carries these faithfully now; it used to
  // drop them, which let customers book into hours the restaurant had closed.
  skippedDayPartialsImported: number
  // FM sent intervals but none survived normalization (malformed or zero-width
  // times). Storing the entry without them would turn a partial block into a
  // whole-day one, so it is reported instead. Should normally be 0.
  skippedDayIntervalsDropped: number
  // Per-item images pulled from FM and re-hosted in Vercel Blob (see
  // ./fm-item-images). itemImagesMissing counts items FM has no image for at all —
  // a real state, not a failure. itemImagesFailed counts images FM claims to have
  // but that could not be fetched/re-hosted; those leave image_url NULL and are
  // picked up by re-running scripts/backfill-item-images-from-fm.ts.
  itemImagesImported: number
  itemImagesMissing: number
  itemImagesFailed: number
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
    skippedDayPartialsImported: 0,
    itemImagesImported: 0, itemImagesMissing: 0, itemImagesFailed: 0,
    unplacedItems: [],
    skippedDayRangesImported: 0, skippedDayIntervalsDropped: 0, hiddenCategorySkipped: 0,
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
  const [fmMenus, fmGroups, fmItems] = await Promise.all([
    fmGetAll(`/api/admin/menu?restaurantReference=${fmRef}`, auth),
    fmGetAll(`/api/restaurants/${fmRef}/extraItemsGroups`, auth),
    fmGetAll(`/api/restaurants/${fmRef}/mealPackages`, auth),
  ])
  if (!fmMenus || !fmGroups || !fmItems) { summary.error = 'FM menus, modifier groups or items could not be read in full'; return summary }
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
    // Same null-vs-falsy fix as prepTime above: `|| 1` turned an explicit FM 0
    // into 1. Math.max(1, …) still floors it, so a 0 becomes 1 either way — but
    // now that is the clamp doing it visibly rather than a coercion hiding it.
    const max = Math.max(1, Math.trunc(g.maxSelectedItems != null ? num(g.maxSelectedItems) : 1))
    // visible + archived were NOT imported before, so an FM-hidden group became
    // permanently visible in Disco: disco_modifier_groups.visible defaults true
    // and the customer read filtered only on archived. Latent rather than live
    // when found (the affected groups had zero item attachments), but live the
    // moment one is attached to an item. `!== false` keeps an absent flag as
    // visible, matching the column default and FM's own Boolean handling.
    const gi = (await sql`
      INSERT INTO disco_modifier_groups (restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, visible, archived, position)
      VALUES (${targetRef}::uuid, ${str(g.name) || 'Group'}, ${str(g.externalName) || str(g.name) || null}, ${str(g.subExternalName) || null}, ${min}, ${max}, ${g.visible !== false}, ${g.archived === true}, ${gpos++})
      RETURNING reference
    `) as { reference: string }[]
    const discoGroup = gi[0].reference
    groupMap.set(gRef, discoGroup)
    summary.groups++
    let mpos = 0
    for (const a of arrOf(g.addOns)) {
      const { name, price } = addOnNamePrice(a.name, a.price)
      const mi = (await sql`INSERT INTO disco_modifiers (restaurant_reference, name, price, visible, archived, position) VALUES (${targetRef}::uuid, ${name}, ${price}, ${a.visible !== false}, ${a.archived === true}, ${mpos}) RETURNING reference`) as { reference: string }[]
      await sql`INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position) VALUES (${discoGroup}::uuid, ${mi[0].reference}::uuid, ${mpos})`
      summary.modifiers++; if (price > 0) summary.pricedModifiers++
      mpos++
    }
  }

  // ── 2) Menus (with faithful operational settings) ──
  const menuMap = new Map<string, string>() // fm menu ref → disco menu ref
  // disco menu ref → menu NAME, so the last-resort fallback can say where it put
  // an item in words rather than a uuid.
  const menuNameByRef = new Map<string, string>()
  let menuPos = 0
  for (const m of fmMenus) {
    const mRef = str(m.reference); if (!mRef) continue
    const scheduleObj = (m.scheduleOption || {}) as Record<string, unknown>
    const { menu: ms, delivery } = fmMenuToDiscoSettings((m.settings || {}) as Record<string, unknown>, scheduleObj)
    const scheduleConfig = fmScheduleToDiscoConfig(scheduleObj)
    const skipped = fmSkippedDaysToDisco(scheduleObj)
    summary.skippedDayRangesImported += skipped.skippedDays.length
    summary.skippedDayPartialsImported += skipped.partialImported
    summary.skippedDayIntervalsDropped += skipped.droppedWithIntervals.length
    if (skipped.droppedWithIntervals.length) {
      // Loud on purpose — an entry FM marked partial that we could not represent
      // as partial. Left OUT rather than stored as a whole-day block, so the
      // failure mode is "FM blocks hours we don't" and never "we block a day FM
      // leaves open".
      console.warn(`[fm-import] "${str(m.name)}": ${skipped.droppedWithIntervals.length} FM skip(s) carry unparseable time intervals and were NOT imported:`,
        skipped.droppedWithIntervals.map(d => `${d.name || '(unnamed)'} ${d.fromDate}..${d.toDate} (${d.intervals} interval(s))`).join('; '))
    }
    const nm = str(m.name) || 'Menu'
    const mi = (await sql`
      INSERT INTO disco_menus (
        restaurant_reference, name, url, type, description, visible,
        offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
        tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
        max_orders_per_day, lead_time_hours, rolling_availability_days, daily_cutoff_time, hard_cutoff_date,
        delivery_settings, schedule_config, skipped_days, position)
      VALUES (
        ${targetRef}::uuid, ${nm}, ${(slugify(nm) || 'menu') + '-' + menuPos}, ${str(m.type) || 'GENERAL_CATERING'}, ${str(m.description) || null}, ${m.visible !== false},
        ${ms.offersPickup}, ${ms.offersDelivery}, ${ms.serviceChargePct}, ${ms.serviceChargeName},
        ${ms.tipDefaultType}, ${ms.tipDefaultValue}, ${ms.pickupOrderMinimum}, ${ms.deliveryOrderMinimum},
        ${ms.maxOrdersPerDay}, ${ms.leadTimeHours}, ${ms.rollingAvailabilityDays}, ${ms.dailyCutoffTime}::time, ${ms.hardCutoffDate}::date,
        ${delivery ? JSON.stringify(delivery) : null}::jsonb, ${scheduleConfig ? JSON.stringify(scheduleConfig) : null}::jsonb,
        ${skipped.skippedDays.length ? JSON.stringify(skipped.skippedDays) : null}::jsonb, ${menuPos++})
      RETURNING reference
    `) as { reference: string }[]
    menuMap.set(mRef, mi[0].reference)
    menuNameByRef.set(mi[0].reference, nm)
    summary.menus++
  }
  // ── 3) Items → categories, placed by FM's own category → menu link ──
  // Every flat-catalog item carries itemCategory.reference, and
  // GET /api/itemCategories?menuReference=… lists EVERY category of a menu —
  // hidden menus and hidden categories included (ItemCategoryServiceImpl.getAll →
  // findAllByMenuReference, not restaurant-scoped, open to SUPER_ADMIN). Together
  // they say exactly which menu each item is on, so nothing is inferred.
  //
  // This replaced a public per-menu traversal plus a "supplementary pass" that
  // GUESSED where items on hidden menus and hidden items belonged (schedule-window
  // match, category-name overlap, party-size wording, else the first visible menu).
  // The guesses copied hidden items into every menu sharing a window: Colonial
  // Ranch Market converted with 1,862 items where FM had 1,112 — 776 hidden copies
  // spread across menus they never belonged to (re-synced 2026-11-09).
  //
  // A category FM has hidden is skipped with its items, as before: Disco's
  // customer read filters hidden categories, but nothing else would stop an item
  // in one from being priced at checkout. An item whose category is on none of
  // the restaurant's menus is not placed anywhere and is named in unplacedItems.
  const catToMenu = new Map<string, { discoMenu: string; name: string; description: string | null; position: number; visible: boolean }>()
  for (const m of fmMenus) {
    const discoMenu = menuMap.get(str(m.reference))
    if (!discoMenu) continue
    const cats = await fmGet(`/api/itemCategories?menuReference=${str(m.reference)}`, auth)
    if (!Array.isArray(cats)) { summary.error = `FM categories for menu "${str(m.name)}" could not be read`; return summary }
    for (const c of cats as Record<string, unknown>[]) {
      const ref = str(c.reference); if (!ref) continue
      catToMenu.set(ref, { discoMenu, name: str(c.name) || 'Menu', description: str(c.description).trim() || null, position: num(c.position), visible: c.visible !== false })
    }
  }

  // One cache for the whole import: FM clones its image rows per restaurant, but an
  // item list can repeat a reference, and content-addressed blob paths dedupe
  // identical bytes across restaurants at the storage layer regardless.
  const itemImageCache = newItemImageCache()
  let itemPos = 0
  const insertItem = async (it: Record<string, unknown>, catRef: string): Promise<void> => {
    const serves = str(it.serves).trim() || null
    const displayPrice = str(it.displayPrice).trim().slice(0, 120) || null
    const minQty = num(it.minQuantity) > 0 ? Math.round(num(it.minQuantity)) : null
    // Item image. image_url was missing from this column list entirely, which is why
    // every native restaurant had zero item images while FM had ~55 per Atlanta Bread
    // location. Best-effort by design: resolveFmItemImage never throws, and a failure
    // leaves image_url NULL rather than failing the import — an image is decoration,
    // and scripts/backfill-item-images-from-fm.ts fills blanks on a later run.
    const imgRef = fmItemImageReference(it)
    let imageUrl: string | null = null
    if (!imgRef) {
      summary.itemImagesMissing++
    } else {
      const img = await resolveFmItemImage(imgRef, itemImageCache, fmItemImageStorageKey(it))
      if (img.ok) { imageUrl = img.url; summary.itemImagesImported++ }
      else { summary.itemImagesFailed++; console.warn(`[fm-faithful-import] item image failed (${str(it.name)}): ${img.reason}`) }
    }
    const ii = (await sql`
      INSERT INTO disco_menu_items (restaurant_reference, category_reference, name, description, price, serves, display_price, min_quantity, allow_special_instructions, visible, position, image_url)
      VALUES (${targetRef}::uuid, ${catRef}::uuid, ${str(it.name) || 'Item'}, ${str(it.description) || null}, ${num(it.price)}, ${serves}, ${displayPrice}, ${minQty}, ${it.allowedSpecialInstructions === true}, ${it.visible !== false}, ${itemPos++}, ${imageUrl})
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

  const itemsByCat = new Map<string, Record<string, unknown>[]>()
  for (const it of fmItems) {
    const c = typeof it.itemCategory === 'object' && it.itemCategory ? (it.itemCategory as Record<string, unknown>) : null
    const cref = c ? str(c.reference) : ''
    if (!cref || !catToMenu.has(cref)) {
      summary.unplacedItems.push({ name: str(it.name) || '(unnamed)', category: (c ? str(c.name) : str(it.itemCategory)) || '(none)' })
      continue
    }
    const list = itemsByCat.get(cref) || []
    list.push(it)
    itemsByCat.set(cref, list)
  }
  if (summary.unplacedItems.length) {
    console.log(`[fm-faithful-import] ${summary.unplacedItems.length} FM item(s) are on no menu and were not imported:`, summary.unplacedItems.map(u => `${u.name} (${u.category})`).join('; '))
  }

  // Menu by menu, categories and items in FM's own order.
  const catsByMenu = new Map<string, [string, { name: string; description: string | null; position: number; visible: boolean }][]>()
  for (const [ref, c] of catToMenu) {
    const list = catsByMenu.get(c.discoMenu) || []
    list.push([ref, c])
    catsByMenu.set(c.discoMenu, list)
  }
  for (const discoMenu of menuMap.values()) {
    const cats = (catsByMenu.get(discoMenu) || []).sort((a, b) => a[1].position - b[1].position)
    let cpos = 0
    for (const [fmCatRef, c] of cats) {
      const items = (itemsByCat.get(fmCatRef) || []).sort((a, b) => num(a.position) - num(b.position))
      if (!c.visible) { summary.hiddenCategorySkipped += items.length; continue }
      if (!items.length) continue
      const ci = (await sql`INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name, description, position) VALUES (${targetRef}::uuid, ${discoMenu}::uuid, ${c.name}, ${c.description}, ${cpos++}) RETURNING reference`) as { reference: string }[]
      summary.categories++
      for (const it of items) await insertItem(it, ci[0].reference)
    }
  }

  return summary
}
