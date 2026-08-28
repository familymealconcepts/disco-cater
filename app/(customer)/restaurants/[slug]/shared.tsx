import { cache } from 'react'
import { MENU_ACTIVE_SQL } from '../../../../lib/menu-state'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import RestaurantClient from './RestaurantClient'
import NoLongerAvailable from '../../../components/NoLongerAvailable'
import { sql, runMigrations, runDiscoMenuMigrations, withDiscoTables } from '../../../../lib/db'
import { buildNativeScheduleOption, type NativeScheduleConfig } from '../../../../lib/scheduling/native-schedule'
import { menuRowToSettings, menuRowToScheduleExtras, type MenuSettingsRow } from '../../../../lib/menu-settings'

// ─────────────────────────────────────────────────────────────────────────────
// Shared restaurant-page logic used by BOTH ordering routes:
//   • /restaurants/[slug] — 3rd-party marketplace URL (sends sourceoforder
//     "DISCO" to FM → lead-gen fee applies). This is the indexable, SEO page.
//   • /order/[slug]       — 1st-party direct URL the restaurant shares on its
//     own site (sends sourceoforder "FAMILYMEAL" → no lead-gen fee). noindex,
//     canonical points at the marketplace page so the two don't compete.
// Both render the IDENTICAL RestaurantClient + CheckoutDrawer; the ONLY
// difference is the `isFirstParty` flag threaded down to CheckoutDrawer, which
// picks the wire value of sourceoforder. Never display the raw wire strings in
// the UI — show "3P"/"1P" instead.
// ─────────────────────────────────────────────────────────────────────────────

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const SITE = 'https://www.discocater.com'

export interface CachedRestaurant {
  restaurantReference: string
  name: string
  slug: string | null
  address: string | null
  location: string | null
  cuisine: string | null
  description: string | null
  imageUrl: string | null
  iconUrl: string | null
  isPremium: boolean | null
  lat: number | null
  lng: number | null
  // Disco-native only (see lib/disco-restaurant-archive.ts). Checked FIRST,
  // ahead of is_live/visible/online_ordering_enabled — archive is a stronger
  // gate than any of those, so an archived restaurant must never fall through
  // to native-menu rendering or the FM lookup below just because those other
  // flags happen to still say "on."
  isArchived: boolean
}

// React.cache() memoizes within a single request — generateMetadata and the
// page render both call this and share one Neon round-trip. The editorial
// fields this used to read from Sanity (cuisine/description/image) now live
// in disco_restaurant_cache — see the Sanity-sunset investigation for why:
// Neon already independently held equivalent (often more current) curated
// data via the admin restaurant-edit dialog for virtually every restaurant.
// Exported for reuse by order/page.tsx (the 1st-party route's own lookup).
export const getCachedRestaurant = cache(async (slug: string): Promise<CachedRestaurant | null> => {
  const rows = (await withDiscoTables(() => sql`
    SELECT c.restaurant_reference, c.name, c.slug, c.address, c.location, c.cuisine, c.description,
           c.image_url, c.icon_url, c.lat, c.lng, o.is_premium, o.archived_at
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    WHERE LOWER(c.slug) = LOWER(${slug})
    LIMIT 1
  `, runMigrations).catch(() => [])) as {
    restaurant_reference: string; name: string; slug: string | null; address: string | null; location: string | null
    cuisine: string | null; description: string | null; image_url: string | null; icon_url: string | null
    lat: string | number | null; lng: string | number | null; is_premium: boolean | null; archived_at: string | null
  }[]
  const r = rows[0]
  if (!r) return null
  return {
    restaurantReference: r.restaurant_reference,
    name: r.name, slug: r.slug, address: r.address, location: r.location,
    cuisine: r.cuisine, description: r.description,
    imageUrl: r.image_url, iconUrl: r.icon_url, isPremium: r.is_premium,
    lat: r.lat != null ? Number(r.lat) : null, lng: r.lng != null ? Number(r.lng) : null,
    isArchived: r.archived_at != null,
  }
})

function truncate(s: string, n: number): string {
  if (!s) return ''
  if (s.length <= n) return s
  return s.slice(0, n - 1).trimEnd() + '…'
}

interface FmRestaurantLookup {
  reference: string
  businessName: string
  businessNameWithoutSpaces?: string
  address?: {
    addressLine1?: string
    addressLine2?: string
    city?: string
    state?: string
    zipcode?: string
    phoneNumber?: string
  }
  image?: { reference?: string }
  // Restaurant-level FM settings (RestaurantSimplePublicResponseDto). FM exposes
  // these on the RESTAURANT, not the menu — the ordering page reads them here.
  enableMenuSearch?: boolean
  deliveryOrderTimeWindows?: string
}

const resolveFmRef = cache(async (slug: string): Promise<string | null> => {
  try {
    const res = await fetch(`${FM}/public-api/restaurants`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    })
    if (!res.ok) return null
    const list: { reference: string; businessNameWithoutSpaces: string }[] = await res.json()
    const target = slug.toLowerCase()
    return list.find(r => r.businessNameWithoutSpaces?.toLowerCase() === target)?.reference ?? null
  } catch {
    return null
  }
})

// FM direct slug lookup — mirrors getRestaurantByName() in
// _system/_services/restaurant/restaurant.service.ts:436-440 + the
// two-step flow used by checkout-pantry.component.ts:480-507.
// Returns reference + businessName (NOTE: this endpoint does NOT include the
// address — use fetchFmRestaurantByRef for that). null if FM 404s the slug.
const fetchFmRestaurantBySlug = cache(async (slug: string): Promise<FmRestaurantLookup | null> => {
  try {
    // FM's own businessNameWithoutSpaces values are stored lowercase (see
    // resolveFmRef) — normalize here too so a URL typed/shared with different
    // capitalization (e.g. "AlmostHome" vs "almosthome") still resolves.
    const res = await fetch(`${FM}/public-api/restaurants/business/${encodeURIComponent(slug.toLowerCase())}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data || !data.reference) return null
    return data as FmRestaurantLookup
  } catch {
    return null
  }
})

// FM restaurant detail BY REFERENCE — /public-api/restaurants/{ref}. Unlike the
// business-by-slug endpoint, this DOES carry the full `address` object
// ({ addressLine1, city, state, zipcode, … }). This is the canonical address
// source for the page header + SEO (Sanity is missing it for some restaurants,
// e.g. Katz's). cache()d so generateMetadata + the page render share one call.
const fetchFmRestaurantByRef = cache(async (ref: string): Promise<FmRestaurantLookup | null> => {
  try {
    const res = await fetch(`${FM}/public-api/restaurants/${ref}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data || !data.reference) return null
    return data as FmRestaurantLookup
  } catch {
    return null
  }
})

// Resolve a restaurant's FM address object from an FM slug (business lookup →
// ref → by-ref detail). cache()d on the slug so metadata + render share it.
const resolveFmAddress = cache(async (fmSlug: string): Promise<FmRestaurantLookup['address'] | null> => {
  if (!fmSlug) return null
  const body = await fetchFmRestaurantBySlug(fmSlug)
  const ref = body?.reference ?? (await resolveFmRef(fmSlug))
  if (!ref) return null
  const detail = await fetchFmRestaurantByRef(ref)
  return detail?.address ?? null
})

// "City, ST" from an FM address — the right granularity for an SEO "Catering
// in {loc}" title, and a never-blank last resort for the header.
function cityState(a?: FmRestaurantLookup['address'] | null): string {
  if (!a) return ''
  return [a.city, a.state].filter(Boolean).join(', ')
}

function joinFmAddress(a?: FmRestaurantLookup['address']): string {
  if (!a) return ''
  const line = [a.addressLine1, a.addressLine2].filter(Boolean).join(', ')
  const cityStateZip = [
    [a.city, a.state].filter(Boolean).join(', '),
    a.zipcode,
  ].filter(Boolean).join(' ')
  return [line, cityStateZip].filter(Boolean).join(' · ').replace(/ · ([A-Z]{2})/g, ', $1')
}

// Full street address, comma-joined: "123 Main St, New York, NY 10001".
// Used for the restaurant header so it shows the complete address rather than
// just the "City, ST" that Sanity's `location` field carries.
//
// Some FM records stuff the WHOLE address (incl. city/state/zip and a trailing
// "USA") into addressLine1 — e.g. "205 E Houston St, New York, NY 10002 USA".
// In that case appending city/state/zip again double-prints it, so when
// addressLine1 already contains both the city and the state we show it alone.
function formatFullAddress(a?: FmRestaurantLookup['address'] | null): string {
  if (!a) return ''
  const street = [a.addressLine1, a.addressLine2].filter(Boolean).join(', ')
  // Drop a trailing "USA" (US-only platform) — handles "… 10002 USA" / "…, USA".
  const cleanedStreet = street.replace(/[,\s]+USA\s*$/i, '').trim()

  const line1 = (a.addressLine1 || '').toLowerCase()
  const hasCity = !!a.city && line1.includes(a.city.toLowerCase())
  const hasState = !!a.state && new RegExp(`\\b${a.state.toLowerCase()}\\b`).test(line1)
  // addressLine1 is already a full address → don't re-append city/state/zip.
  if (hasCity && hasState) return cleanedStreet

  const tail = [
    [a.city, a.state].filter(Boolean).join(', '),
    a.zipcode,
  ].filter(Boolean).join(' ')
  return [cleanedStreet, tail].filter(Boolean).join(', ')
}

// Exported for reuse by order/page.tsx (the 1st-party route's own package list).
export async function fetchMenuData(restaurantRef: string) {
  try {
    const menuRes = await fetch(
      `${FM}/public-api/menu?restaurantReference=${restaurantRef}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 300 } }
    )
    if (!menuRes.ok) return []
    const menus = await menuRes.json()
    if (!Array.isArray(menus) || !menus.length) return []

    // E.2 — default-menu selection. FM picks menus[0] in API order with
    // no client sort (checkout-pantry.component.ts:579). FM's menu model
    // carries a numeric `position` that the admin reorders; the primary
    // menu is position 0. We sort by position ascending so the admin-
    // defined primary leads regardless of the order the public endpoint
    // happens to return. Stable no-op when `position` is absent (all
    // undefined → original order preserved). [NEEDS REVIEW] — if FM's
    // public endpoint already sorts by position this is a harmless
    // double-sort; if it returns insertion order this corrects the
    // "[Copy] Summer Menu shows first" symptom.
    const ordered = [...menus].sort((a, b) => {
      const pa = typeof a?.position === 'number' ? a.position : Number.MAX_SAFE_INTEGER
      const pb = typeof b?.position === 'number' ? b.position : Number.MAX_SAFE_INTEGER
      return pa - pb
    })

    const result = []
    for (const menu of ordered) {
      const pkgRes = await fetch(
        `${FM}/public-api/restaurants/${restaurantRef}/mealPackages?menuReference=${menu.reference}`,
        { headers: { Accept: 'application/json' }, next: { revalidate: 300 } }
      )
      if (!pkgRes.ok) continue
      const cats = await pkgRes.json()
      result.push({ menu, categories: Array.isArray(cats) ? cats : [] })
    }
    return result
  } catch {
    return []
  }
}

// Build page metadata. `basePath` is the route the canonical/OG URL is built
// from. `noindex` is set for the 1st-party /order route so it doesn't compete
// with the marketplace page in search; its canonical still points at the
// marketplace URL to consolidate ranking signals.
export async function buildRestaurantMetadata(
  slug: string,
  opts: { basePath: '/restaurants' | '/order'; noindex?: boolean },
): Promise<Metadata> {
  const r = await getCachedRestaurant(slug)
  // Canonical URLs are always lowercase regardless of how the visitor typed
  // or shared this one — slug lookups are case-insensitive (see
  // getCachedRestaurant etc.), but SEO canonicalization should still pick
  // ONE casing consistently rather than mirroring whatever the request used.
  const canonicalSlug = slug.toLowerCase()
  // 1P (/order) canonicalizes to the marketplace page so duplicate content
  // doesn't split SEO; the 3P (/restaurants) page is self-canonical.
  const canonical = opts.noindex ? `${SITE}/restaurants/${canonicalSlug}` : `${SITE}${opts.basePath}/${canonicalSlug}`
  const url = `${SITE}${opts.basePath}/${canonicalSlug}`
  // An archived restaurant is always noindex, regardless of which route this
  // is — it must never rank in search once it's gone, even on the otherwise-
  // indexable /restaurants page.
  const robots = (opts.noindex || r?.isArchived) ? { index: false, follow: true } : undefined

  // Fall back to a minimal but useful set if Neon has no cache row yet (e.g.
  // FM fallback path) — the page itself still renders via the FM lookup.
  if (!r) {
    return {
      title: 'Catering | Disco Cater',
      description: 'Order catering on Disco Cater.',
      alternates: { canonical },
      ...(robots ? { robots } : {}),
    }
  }

  // Locale for the title/description: Neon's curated `location` first, then
  // FM's city/state (blank for some restaurants, e.g. Katz's), then the
  // cached street address as a last resort. Neon's own `slug` is already the
  // FM-resolvable one (no separate derivation needed).
  const fmAddr = await resolveFmAddress(slug)
  const loc = r.location || cityState(fmAddr) || r.address || ''
  const title = loc
    ? `${r.name} — Catering in ${loc} | Disco Cater`
    : `${r.name} — Catering | Disco Cater`
  const description = r.description
    ? truncate(String(r.description), 155)
    : `Order catering from ${r.name}${loc ? ` in ${loc}` : ''} on Disco Cater.`
  const ogImage = r.imageUrl || r.iconUrl || null

  return {
    title,
    description,
    alternates: { canonical },
    ...(robots ? { robots } : {}),
    openGraph: {
      title,
      description,
      url,
      siteName: 'Disco Cater',
      type: 'website',
      ...(ogImage ? { images: [{ url: ogImage }] } : {}),
    },
    twitter: {
      card: ogImage ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
  }
}

// Visually-hidden block so the restaurant name + description are in the HTML
// before the client component hydrates — gives Google something to index even
// if it stops at static HTML. Standard sr-only CSS (clip + 1px).
const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
}

function SeoBlock({ name, location, cuisine, description }: {
  name: string; location?: string; cuisine?: string; description?: string
}) {
  return (
    <div style={srOnly} aria-hidden="false">
      <h1>{name}</h1>
      {(location || cuisine) && <p>{[location, cuisine].filter(Boolean).join(' · ')}</p>}
      {description && <p>{description}</p>}
    </div>
  )
}

// Native modifier shapes — mirror RestaurantClient's FmAddOn / FmExtraItemsGroup so
// the emitted menu packages carry modifiers the customer UI renders + prices as-is.
interface NativeAddOn { reference: string; name: string; price: number; visible: boolean; position: number }
interface NativeExtraItemsGroup {
  reference: string; name: string; externalName?: string; subExternalName?: string
  minSelectedItems: number; maxSelectedItems: number; visible: boolean; enabled: boolean; addOns: NativeAddOn[]
}

// Disco-native restaurants live entirely in Neon (no FM/Sanity record). If this
// slug is a LIVE disco-native restaurant, load its menu from disco_menu_* and
// shape it into the same MenuSection[] the FM path produces, so RestaurantClient
// renders it unchanged.
async function loadDiscoNativeRestaurant(slug: string) {
  try {
    // This lookup runs on EVERY restaurant page render — including the ~4,000
    // FM-backed ones, which fall straight through to the FM path below. Eagerly
    // awaiting runMigrations() (57 statements) put that on the cold-render
    // critical path of the hottest customer surface for no benefit.
    const rows = (await withDiscoTables(() => sql`
      SELECT c.restaurant_reference, c.name, c.slug, c.address, c.location, c.cuisine, c.description, c.image_url, c.icon_url,
             COALESCE(o.online_ordering_enabled, true) AS online_ordering_enabled,
             COALESCE(o.enable_menu_search, false) AS enable_menu_search,
             o.announcement, COALESCE(o.delivery_order_time_windows, 'exact') AS delivery_order_time_windows
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      WHERE LOWER(c.slug) = LOWER(${slug}) AND c.is_disco_native = true AND c.is_live = true
      LIMIT 1
    `, runMigrations)) as { restaurant_reference: string; name: string; slug: string | null; address: string | null; location: string | null; cuisine: string | null; description: string | null; image_url: string | null; icon_url: string | null; online_ordering_enabled: boolean; enable_menu_search: boolean; announcement: string | null; delivery_order_time_windows: string }[]
    const r = rows[0]
    if (!r) return null

    // Only genuinely disco-native restaurants get this far, so the menu suite
    // was already off the FM-backed path — but it still cost 46 statements on
    // every cold native render.
    const cats = (await withDiscoTables(() => sql`
      SELECT reference, name, description, menu_reference FROM disco_menu_categories
      WHERE restaurant_reference = ${r.restaurant_reference}::uuid AND visible = true
      ORDER BY position, id
    `, runDiscoMenuMigrations)) as { reference: string; name: string; description: string | null; menu_reference: string | null }[]
    const items = (await sql`
      SELECT reference, category_reference, name, description, price, serves,
             display_price, min_quantity, allow_special_instructions,
             vegetarian, contains_nuts, gluten_free, vegan, max_inventory_per_day,
             image_url
      FROM disco_menu_items
      WHERE restaurant_reference = ${r.restaurant_reference}::uuid AND visible = true
      ORDER BY position, id
    `) as {
      reference: string; category_reference: string | null; name: string; description: string | null
      price: string | number; serves: string | null; display_price: string | null; min_quantity: number | null
      allow_special_instructions: boolean; vegetarian: boolean; contains_nuts: boolean; gluten_free: boolean; vegan: boolean
      image_url: string | null
      max_inventory_per_day: number | null
    }[]

    // Attached modifier groups per item (Stage 4 consumption). Shaped into the
    // FM `extraItemsGroups` structure RestaurantClient already renders + prices, so
    // native modifiers appear + charge with zero FM. Only ENABLED attachments,
    // and groups/modifiers that are both non-archived AND visible — `visible`
    // was previously unfiltered here while the importer never wrote it, so an
    // FM-hidden option would have been sellable in Disco.
    const groupsByItem = new Map<string, NativeExtraItemsGroup[]>()
    try {
      const attach = (await sql`
        SELECT ig.item_reference, ig.position,
               g.reference, g.name, g.external_name, g.sub_external_name, g.min_selected, g.max_selected
        FROM disco_item_groups ig
        JOIN disco_menu_items mi ON mi.reference = ig.item_reference AND mi.restaurant_reference = ${r.restaurant_reference}::uuid
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
      console.error('[shared] native item modifier groups load failed (menu still renders):', e instanceof Error ? e.message : e)
    }

    const toPkg = (it: typeof items[number]) => ({
      reference: it.reference, name: it.name, description: it.description,
      price: Number(it.price) || 0, serves: it.serves,
      displayPrice: it.display_price || undefined,
      minQuantity: it.min_quantity ?? undefined,
      // A READY-MADE URL, not FM's {image:{reference}} shape. Native item images are
      // re-hosted in Vercel Blob at import (lib/menu-import/fm-item-images), so there
      // is no FM reference to resolve and pkgImg() must not be applied to it.
      // RestaurantClient prefers imageUrl and falls back to image.reference, which is
      // what an FM-backed restaurant still supplies.
      imageUrl: it.image_url || undefined,
      allowedSpecialInstructions: it.allow_special_instructions === true,
      vegetarian: it.vegetarian === true, containsNuts: it.contains_nuts === true,
      glutenFree: it.gluten_free === true, vegan: it.vegan === true,
      maxInventoryPerDay: it.max_inventory_per_day ?? null,
      extraItemsGroups: groupsByItem.get(it.reference) ?? [],
    })

    // Every visible menu, not just the primary — restaurants build several
    // (Catering, Gift Cards, Grocery, ...) and the customer page used to show
    // only one. Same query as before, minus LIMIT 1: still one round-trip,
    // returning N rows instead of 1.
    const menuRows = (await sql`
      SELECT reference, name, schedule_config, availability_mode,
             to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
             offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
             tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
             max_orders_per_day, lead_time_hours, rolling_availability_days,
             to_char(daily_cutoff_time, 'HH24:MI') AS daily_cutoff_time,
             to_char(hard_cutoff_date, 'YYYY-MM-DD') AS hard_cutoff_date,
             delivery_settings, skipped_days, include_utensils
      FROM disco_menus
      WHERE restaurant_reference = ${r.restaurant_reference}::uuid AND ${sql.unsafe(MENU_ACTIVE_SQL)}
      ORDER BY position, id
    `) as (MenuSettingsRow & { reference: string; name: string; schedule_config: NativeScheduleConfig | null; availability_mode: string | null; start_date: string | null; end_date: string | null; skipped_days: { fromDate: string; toDate: string; intervals?: { fromTime: string; toTime: string }[] }[] | null })[]
    // The "primary" reference is only used now as the NULL-menu_reference
    // fallback target below (categories/items predating the multi-menu model,
    // or the zero-visible-menus edge case) — never a guess about which menu
    // the customer is ordering from.
    const primary = menuRows[0]

    // Restaurant-wide Closed Days apply to every menu; each menu ALSO has its
    // own skipped_days. Merged per-menu below, not once for "the" menu.
    const closedRows = (await sql`
      SELECT to_char(from_date, 'YYYY-MM-DD') AS from_date, to_char(to_date, 'YYYY-MM-DD') AS to_date
      FROM disco_restaurant_closed_days WHERE restaurant_reference = ${r.restaurant_reference}::uuid
    `.catch(() => [])) as { from_date: string; to_date: string }[]

    // Categories/items were already loaded restaurant-wide above (unchanged —
    // still one query each, no N+1). What's new is grouping them per menu
    // instead of flattening into one list. category.menu_reference is
    // nullable — pre-multi-menu categories, or a restaurant with categories
    // never explicitly re-linked — and NULL never equals a real menu
    // reference, so an exact match alone would make those categories vanish
    // from the customer page. Confirmed live: 1 category on "Test 34"
    // (bf5c5b70-f065-4f58-a165-e484ce89a707) has menu_reference = NULL today.
    // Falls back to the primary (lowest-position) visible menu — the same
    // menu everything implicitly belonged to before this change, so a
    // single-menu restaurant's categories land exactly where they always did.
    const menuData = (menuRows.length ? menuRows : [undefined]).map(m => {
      const menuCats = cats.filter(c => c.menu_reference === (m?.reference ?? null) || (c.menu_reference == null && m?.reference === primary?.reference))
      const categories = menuCats.map(c => ({
        reference: c.reference, name: c.name, description: c.description,
        mealPackages: items.filter(it => it.category_reference === c.reference).map(toPkg),
      }))
      // Orphan items (no category at all) get the same primary-menu fallback.
      if (!m || m.reference === primary?.reference) {
        const orphans = items.filter(it => !cats.some(c => c.reference === it.category_reference))
        if (orphans.length) {
          categories.push({ reference: 'uncategorized', name: 'Menu', description: null, mealPackages: orphans.map(toPkg) })
        }
      }

      // `intervals` must survive this mapping — a menu blackout can block only part
      // of a day, and picking just {fromDate, toDate} here would tell the customer's
      // time picker the whole day is fine while the server refuses the blocked
      // hours at placement. Restaurant-level Closed Days have no hours concept and
      // are genuinely whole-day, so they map across unchanged.
      const menuSkipped = Array.isArray(m?.skipped_days)
        ? (m!.skipped_days as { fromDate: string; toDate: string; intervals?: { fromTime: string; toTime: string }[] }[])
        : []
      const skippedDays = [
        ...menuSkipped.map(s => ({
          fromDate: s.fromDate,
          toDate: s.toDate,
          ...(s.intervals?.length ? { intervals: s.intervals } : {}),
        })),
        ...closedRows.map(c => ({ fromDate: c.from_date, toDate: c.to_date })),
      ]
      const scheduleOption = {
        ...buildNativeScheduleOption(m?.schedule_config ?? null, m?.availability_mode ?? null, m?.start_date ?? null, m?.end_date ?? null),
        ...(m ? menuRowToScheduleExtras(m) : {}),
        ...(skippedDays.length ? { skippedDays } : {}),
      }
      const settings = m ? menuRowToSettings(m) : { menuAvailability: ['PICKUP', 'DELIVERY'], menuAvailabilityExplicit: false }

      return {
        menu: { reference: m?.reference || 'disco-catering', name: m?.name || 'Catering Menu', scheduleOption, settings, includeUtensils: (m as { include_utensils?: boolean } | undefined)?.include_utensils === true },
        categories,
      }
    })

    return {
      restaurant: {
        name: r.name, address: r.address || undefined, cuisine: r.cuisine || undefined,
        description: r.description || undefined, image: r.image_url || null,
        // Logo (icon_url) — the header thumbnail prefers this over the
        // Marketplace Image; native restaurants never carried it before, so the
        // header silently fell straight to image_url regardless of a real logo.
        iconUrl: r.icon_url || null, imageUrl: r.image_url || null,
        isDisco: true, location: r.location || undefined,
      },
      menuData,
      reference: r.restaurant_reference,
      acceptingOrders: r.online_ordering_enabled !== false,
      enableMenuSearch: r.enable_menu_search === true,
      deliveryOrderTimeWindows: r.delivery_order_time_windows || 'exact',
      announcement: (r.announcement || '').trim() || null,
    }
  } catch (err) {
    console.error('[shared] loadDiscoNativeRestaurant failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// Shared page body for both routes. `isFirstParty` is the ONLY thing that
// differs between them — it flows through RestaurantClient into CheckoutDrawer,
// which uses it to send sourceoforder "FAMILYMEAL" (1P) instead of "DISCO" (3P).
export async function RestaurantView({
  slug,
  isFirstParty = false,
}: {
  slug: string
  isFirstParty?: boolean
}) {
  // Archive is checked FIRST, ahead of everything else in this function —
  // it's a fourth, stronger gate than is_live/visible/online_ordering_enabled
  // (see lib/disco-restaurant-archive.ts), so an archived restaurant must
  // never reach native-menu loading or the FM fallback below. Disco-native
  // only for now; getCachedRestaurant is React-memoized per request, so this
  // costs nothing extra — loadDiscoNativeRestaurant and the FM path below
  // both call it again and get the same cached row.
  const cachedForArchiveCheck = await getCachedRestaurant(slug)
  if (cachedForArchiveCheck?.isArchived) {
    return (
      <NoLongerAvailable
        icon="🏚"
        title="This restaurant is no longer available"
        message="This restaurant has closed on Disco Cater. Browse our marketplace to find catering near you."
      />
    )
  }

  // Disco-native restaurants (no FM/Sanity record) take precedence — render
  // their Neon menu directly. TODO: date/time availability + checkout for
  // disco-native restaurants use the native ordering endpoints; FM-specific
  // availability calls in RestaurantClient are no-ops for these (the menu,
  // item names, descriptions and prices render correctly).
  const native = await loadDiscoNativeRestaurant(slug)
  if (!native) {
    // A disco-native restaurant that hasn't gone live yet (is_live = false) must
    // never fall through to Sanity/FM below — that risks silently serving an
    // unrelated restaurant that happens to share this slug (e.g. a
    // become-a-partner shadow FM record), instead of a clear "not available".
    const notLiveNative = (await withDiscoTables(() => sql`
      SELECT 1 FROM disco_restaurant_cache WHERE LOWER(slug) = LOWER(${slug}) AND is_disco_native = true LIMIT 1
    `, runMigrations).catch(() => [])) as unknown[]
    if (notLiveNative.length > 0) return notFound()
  }
  if (native) {
    return (
      <>
        <SeoBlock
          name={native.restaurant.name}
          location={native.restaurant.location}
          cuisine={native.restaurant.cuisine}
          description={native.restaurant.description}
        />
        <RestaurantClient
          restaurant={native.restaurant}
          fmSlug={slug}
          fmRef={native.reference}
          menuData={native.menuData}
          slug={slug}
          isFirstParty={isFirstParty}
          restaurantSettings={{ onlineOrderingAllowed: native.acceptingOrders, enableMenuSearch: native.enableMenuSearch, deliveryOrderTimeWindows: native.deliveryOrderTimeWindows, announcement: native.announcement ?? undefined }}
        />
      </>
    )
  }

  // Editorial content (cuisine tags, description, hero image) now comes from
  // Neon's disco_restaurant_cache — see the Sanity-sunset investigation for
  // why: it already independently holds equivalent (often more current)
  // curated data via the admin restaurant-edit dialog for virtually every
  // restaurant, whether or not Sanity ever had a doc for it.
  const cached = await getCachedRestaurant(slug)
  const cuisines = cached?.cuisine
    ? cached.cuisine.split(',').map(s => s.trim()).filter(Boolean)
    : []

  // FM's customer slug lookup at /public-api/restaurants/business/{slug}
  // returns any restaurant by businessNameWithoutSpaces, marketplace type, or
  // ordering type — regardless of Neon cache state. This makes Test Kitchen
  // (type: ORDERING) directly orderable at /restaurants/test-kitchen. Ordering
  // itself is entirely FM-mediated for non-native restaurants, so no FM
  // record here is a genuine 404, not just missing editorial content.
  const fmRestaurant = await fetchFmRestaurantBySlug(slug)
  if (!fmRestaurant) return notFound()

  // Address comes from the by-reference detail (business-by-slug has none).
  const fmDetail = await fetchFmRestaurantByRef(fmRestaurant.reference)
  const fmFullAddress = formatFullAddress(fmDetail?.address)
  const menuData = await fetchMenuData(fmRestaurant.reference)

  const FM_IMG = process.env.NEXT_PUBLIC_FM_API_BASE_URL || 'https://api.familymeal.com'
  const restaurant = {
    name: cached?.name || fmRestaurant.businessName,
    // FM full street address first, then Neon's cached address, then Neon's
    // "City, ST" location, then FM's own city/state — so it's never blank.
    address: fmFullAddress || cached?.address || cached?.location || cityState(fmDetail?.address) || joinFmAddress(fmRestaurant.address),
    cuisine: cuisines[0],
    cuisines,
    description: cached?.description || undefined,
    image: fmRestaurant.image?.reference
      ? { asset: { url: `${FM_IMG}/public-api/images/${fmRestaurant.image.reference}/download?size=600` } }
      : undefined,
    iconUrl: cached?.iconUrl ?? null,
    imageUrl: cached?.imageUrl ?? null,
    // Keep every order/link button on Disco Cater — never hand off to
    // familymeal.com. Ordering itself still uses the FM reference passed to
    // RestaurantClient; this only controls where the list/map "Order" buttons point.
    orderUrl: `/restaurants/${slug}`,
    isDisco: cached?.isPremium === true,
    // City/State so the header never renders blank if the full address is empty.
    location: cached?.location || cityState(fmDetail?.address) || undefined,
    tags: [] as string[],
  }

  return (
    <>
      <SeoBlock
        name={restaurant.name}
        location={restaurant.location || restaurant.address}
        cuisine={restaurant.cuisine}
        description={restaurant.description}
      />
      <RestaurantClient
        restaurant={restaurant}
        fmSlug={fmRestaurant.businessNameWithoutSpaces || slug}
        fmRef={fmRestaurant.reference}
        menuData={menuData}
        slug={slug}
        isFirstParty={isFirstParty}
        restaurantSettings={{
          enableMenuSearch: fmDetail?.enableMenuSearch,
          deliveryOrderTimeWindows: fmDetail?.deliveryOrderTimeWindows,
        }}
      />
    </>
  )
}
