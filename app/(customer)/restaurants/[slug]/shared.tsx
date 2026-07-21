import { cache } from 'react'
import type { Metadata } from 'next'
import { createClient } from '@sanity/client'
import { notFound } from 'next/navigation'
import RestaurantClient from './RestaurantClient'
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

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const SITE = 'https://www.discocater.com'

// React.cache() memoizes within a single request — generateMetadata and the
// page render both call this and share one Sanity round-trip.
const getSanityRestaurant = cache(async (slug: string) => {
  return sanity.fetch(
    `*[_type=="restaurant" && slug.current==$slug][0]{
      name, slug, address, cuisine, cuisines, description,
      image, orderUrl, isDisco, location, tags, lat, lng
    }`,
    { slug },
  )
})

// Sanity image asset → CDN URL (same transform used in RestaurantClient.tsx).
function sanityImageUrl(image: any): string | null {
  const ref: string | undefined = image?.asset?._ref
  if (!ref) return null
  const path = ref.replace(/^image-/, '').replace(/-([a-z]+)$/, '.$1')
  return `https://cdn.sanity.io/images/0j4eqnmw/production/${path}`
}

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
    return list.find(r => r.businessNameWithoutSpaces === slug)?.reference ?? null
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
    const res = await fetch(`${FM}/public-api/restaurants/business/${encodeURIComponent(slug)}`, {
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

async function fetchMenuData(restaurantRef: string) {
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
  const r = await getSanityRestaurant(slug)
  // 1P (/order) canonicalizes to the marketplace page so duplicate content
  // doesn't split SEO; the 3P (/restaurants) page is self-canonical.
  const canonical = opts.noindex ? `${SITE}/restaurants/${slug}` : `${SITE}${opts.basePath}/${slug}`
  const url = `${SITE}${opts.basePath}/${slug}`
  const robots = opts.noindex ? { index: false, follow: true } : undefined

  // Fall back to a minimal but useful set if Sanity has no doc (e.g. FM
  // fallback path) — the page itself still renders via the FM lookup.
  if (!r) {
    return {
      title: 'Catering | Disco Cater',
      description: 'Order catering on Disco Cater.',
      alternates: { canonical },
      ...(robots ? { robots } : {}),
    }
  }

  // Locale for the title/description: Sanity's curated `location` first, then
  // FM's city/state (Sanity is blank for some restaurants, e.g. Katz's), then
  // the Sanity address as a last resort.
  const fmSlug = r.orderUrl
    ? r.orderUrl.replace(/.*\/disco\//, '').replace(/\/.*/, '').trim()
    : null
  const fmAddr = fmSlug ? await resolveFmAddress(fmSlug) : null
  const loc = r.location || cityState(fmAddr) || r.address || ''
  const title = loc
    ? `${r.name} — Catering in ${loc} | Disco Cater`
    : `${r.name} — Catering | Disco Cater`
  const description = r.description
    ? truncate(String(r.description), 155)
    : `Order catering from ${r.name}${loc ? ` in ${loc}` : ''} on Disco Cater.`
  const ogImage = sanityImageUrl(r.image)

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
      SELECT c.restaurant_reference, c.name, c.slug, c.address, c.location, c.cuisine, c.description, c.image_url,
             COALESCE(o.online_ordering_enabled, true) AS online_ordering_enabled,
             COALESCE(o.enable_menu_search, false) AS enable_menu_search,
             o.announcement, COALESCE(o.delivery_order_time_windows, 'exact') AS delivery_order_time_windows
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      WHERE c.slug = ${slug} AND c.is_disco_native = true AND c.is_live = true
      LIMIT 1
    `, runMigrations)) as { restaurant_reference: string; name: string; slug: string | null; address: string | null; location: string | null; cuisine: string | null; description: string | null; image_url: string | null; online_ordering_enabled: boolean; enable_menu_search: boolean; announcement: string | null; delivery_order_time_windows: string }[]
    const r = rows[0]
    if (!r) return null

    // Only genuinely disco-native restaurants get this far, so the menu suite
    // was already off the FM-backed path — but it still cost 46 statements on
    // every cold native render.
    const cats = (await withDiscoTables(() => sql`
      SELECT reference, name, description FROM disco_menu_categories
      WHERE restaurant_reference = ${r.restaurant_reference}::uuid AND visible = true
      ORDER BY position, id
    `, runDiscoMenuMigrations)) as { reference: string; name: string; description: string | null }[]
    const items = (await sql`
      SELECT reference, category_reference, name, description, price, serves,
             display_price, min_quantity, allow_special_instructions,
             vegetarian, contains_nuts, gluten_free, vegan
      FROM disco_menu_items
      WHERE restaurant_reference = ${r.restaurant_reference}::uuid AND visible = true
      ORDER BY position, id
    `) as {
      reference: string; category_reference: string | null; name: string; description: string | null
      price: string | number; serves: string | null; display_price: string | null; min_quantity: number | null
      allow_special_instructions: boolean; vegetarian: boolean; contains_nuts: boolean; gluten_free: boolean; vegan: boolean
    }[]

    // Attached modifier groups per item (Stage 4 consumption). Shaped into the
    // FM `extraItemsGroups` structure RestaurantClient already renders + prices, so
    // native modifiers appear + charge with zero FM. Only ENABLED attachments,
    // non-archived groups/modifiers.
    const groupsByItem = new Map<string, NativeExtraItemsGroup[]>()
    try {
      const attach = (await sql`
        SELECT ig.item_reference, ig.position,
               g.reference, g.name, g.external_name, g.sub_external_name, g.min_selected, g.max_selected
        FROM disco_item_groups ig
        JOIN disco_menu_items mi ON mi.reference = ig.item_reference AND mi.restaurant_reference = ${r.restaurant_reference}::uuid
        JOIN disco_modifier_groups g ON g.reference = ig.group_reference AND g.archived = false
        WHERE ig.enabled = true
        ORDER BY ig.position, g.name
      `) as { item_reference: string; position: number; reference: string; name: string; external_name: string | null; sub_external_name: string | null; min_selected: number; max_selected: number }[]
      const groupRefs = [...new Set(attach.map(a => a.reference))]
      const members = groupRefs.length ? (await sql`
        SELECT gm.group_reference, gm.position, m.reference, m.name, m.price
        FROM disco_modifier_group_members gm
        JOIN disco_modifiers m ON m.reference = gm.modifier_reference AND m.archived = false
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
      allowedSpecialInstructions: it.allow_special_instructions === true,
      vegetarian: it.vegetarian === true, containsNuts: it.contains_nuts === true,
      glutenFree: it.gluten_free === true, vegan: it.vegan === true,
      extraItemsGroups: groupsByItem.get(it.reference) ?? [],
    })
    const categories = cats.map(c => ({
      reference: c.reference, name: c.name, description: c.description,
      mealPackages: items.filter(it => it.category_reference === c.reference).map(toPkg),
    }))
    const orphans = items.filter(it => !cats.some(c => c.reference === it.category_reference))
    if (orphans.length) {
      categories.push({ reference: 'uncategorized', name: 'Menu', description: null, mealPackages: orphans.map(toPkg) })
    }

    // Primary menu container — carries the pickup schedule + money/timing settings.
    const menuRows = (await sql`
      SELECT reference, name, schedule_config, availability_mode, to_char(end_date, 'YYYY-MM-DD') AS end_date,
             offers_pickup, offers_delivery, service_charge_pct, service_charge_name,
             tip_default_type, tip_default_value, pickup_order_minimum, delivery_order_minimum,
             max_orders_per_day, lead_time_hours, rolling_availability_days,
             to_char(daily_cutoff_time, 'HH24:MI') AS daily_cutoff_time,
             to_char(hard_cutoff_date, 'YYYY-MM-DD') AS hard_cutoff_date,
             delivery_settings, skipped_days, include_utensils
      FROM disco_menus
      WHERE restaurant_reference = ${r.restaurant_reference}::uuid AND visible = true AND archived = false
      ORDER BY position, id LIMIT 1
    `) as (MenuSettingsRow & { reference: string; name: string; schedule_config: NativeScheduleConfig | null; availability_mode: string | null; end_date: string | null; skipped_days: { fromDate: string; toDate: string }[] | null })[]
    const primary = menuRows[0]
    // Skipped/blackout days: per-menu skipped days + restaurant-wide Closed Days,
    // merged into scheduleOption.skippedDays (the availability engine excludes them).
    const closedRows = (await sql`
      SELECT to_char(from_date, 'YYYY-MM-DD') AS from_date, to_char(to_date, 'YYYY-MM-DD') AS to_date
      FROM disco_restaurant_closed_days WHERE restaurant_reference = ${r.restaurant_reference}::uuid
    `.catch(() => [])) as { from_date: string; to_date: string }[]
    const menuSkipped = Array.isArray(primary?.skipped_days) ? (primary!.skipped_days as { fromDate: string; toDate: string }[]) : []
    const skippedDays = [
      ...menuSkipped.map(s => ({ fromDate: s.fromDate, toDate: s.toDate })),
      ...closedRows.map(c => ({ fromDate: c.from_date, toDate: c.to_date })),
    ]
    // Schedule = pickup windows (schedule_config) + timing settings (lead time,
    // cutoffs, rolling window, max/day) + skipped days. Settings = money + fulfillment.
    const scheduleOption = {
      ...buildNativeScheduleOption(primary?.schedule_config ?? null, primary?.availability_mode ?? null, primary?.end_date ?? null),
      ...(primary ? menuRowToScheduleExtras(primary) : {}),
      ...(skippedDays.length ? { skippedDays } : {}),
    }
    const settings = primary ? menuRowToSettings(primary) : { menuAvailability: ['PICKUP', 'DELIVERY'], menuAvailabilityExplicit: false }

    return {
      restaurant: {
        name: r.name, address: r.address || undefined, cuisine: r.cuisine || undefined,
        description: r.description || undefined, image: r.image_url || null,
        isDisco: true, location: r.location || undefined,
      },
      menuData: [{
        menu: { reference: primary?.reference || 'disco-catering', name: primary?.name || 'Catering Menu', scheduleOption, settings, includeUtensils: (primary as { include_utensils?: boolean })?.include_utensils === true },
        categories,
      }],
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
  // Disco-native restaurants (no FM/Sanity record) take precedence — render
  // their Neon menu directly. TODO: date/time availability + checkout for
  // disco-native restaurants use the native ordering endpoints; FM-specific
  // availability calls in RestaurantClient are no-ops for these (the menu,
  // item names, descriptions and prices render correctly).
  const native = await loadDiscoNativeRestaurant(slug)
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

  // Try Sanity first (existing path — preserves cuisine tags,
  // descriptions, hero image overrides for restaurants curated there).
  const sanityRestaurant = await getSanityRestaurant(slug)

  if (sanityRestaurant) {
    const fmSlug = sanityRestaurant.orderUrl
      ? sanityRestaurant.orderUrl.replace(/.*\/disco\//, '').replace(/\/.*/, '').trim()
      : null
    // Resolve the FM restaurant once — it carries the full street address
    // (Sanity's `location` is only "City, ST" and its `address` is null for most
    // restaurants). Fall back to the list-based ref lookup if the business
    // endpoint doesn't recognize this slug, so ref resolution stays as robust.
    const fmBody = fmSlug ? await fetchFmRestaurantBySlug(fmSlug) : null
    const fmRef = fmBody?.reference ?? (fmSlug ? await resolveFmRef(fmSlug) : null)
    // The address lives on the by-REFERENCE endpoint, not business-by-slug.
    const fmDetail = fmRef ? await fetchFmRestaurantByRef(fmRef) : null
    const fmFullAddress = formatFullAddress(fmDetail?.address)
    const menuData = fmRef ? await fetchMenuData(fmRef) : []
    // FM full street address first, then Sanity's address, then Sanity's
    // "City, ST" location, then FM's city/state — so it's never blank.
    const fullAddress = fmFullAddress || sanityRestaurant.address || sanityRestaurant.location || cityState(fmDetail?.address) || ''
    return (
      <>
        <SeoBlock
          name={sanityRestaurant.name}
          location={sanityRestaurant.location || sanityRestaurant.address}
          cuisine={sanityRestaurant.cuisines?.[0] || sanityRestaurant.cuisine}
          description={sanityRestaurant.description}
        />
        <RestaurantClient
          restaurant={{ ...sanityRestaurant, address: fullAddress }}
          fmSlug={fmSlug}
          fmRef={fmRef}
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

  // FM fallback — A.5 from docs/fm-marketplace-and-access-audit.md.
  // FM's customer slug lookup at /public-api/restaurants/business/{slug}
  // returns any restaurant by businessNameWithoutSpaces, marketplace
  // type or ordering type, regardless of whether Sanity has curated it.
  // This makes Test Kitchen (type: ORDERING, no Sanity doc) directly
  // orderable at /restaurants/test-kitchen.
  const fmRestaurant = await fetchFmRestaurantBySlug(slug)
  if (!fmRestaurant) return notFound()

  // Address comes from the by-reference detail (business-by-slug has none).
  const fmDetail = await fetchFmRestaurantByRef(fmRestaurant.reference)

  const FM_IMG = process.env.NEXT_PUBLIC_FM_API_BASE_URL || 'https://api.familymeal.com'
  const minimalRestaurant = {
    name: fmRestaurant.businessName,
    address: formatFullAddress(fmDetail?.address) || joinFmAddress(fmRestaurant.address),
    cuisine: undefined,
    cuisines: [] as string[],
    description: undefined,
    image: fmRestaurant.image?.reference
      ? { asset: { url: `${FM_IMG}/public-api/images/${fmRestaurant.image.reference}/download?size=600` } }
      : undefined,
    // Keep every order/link button on Disco Cater — never hand off to
    // familymeal.com. Ordering itself still uses the FM reference passed to
    // RestaurantClient; this only controls where the list/map "Order" buttons point.
    orderUrl: `/restaurants/${slug}`,
    isDisco: false,
    // City/State so the header never renders blank if the full address is empty.
    location: cityState(fmDetail?.address) || undefined,
    tags: [] as string[],
  }

  const menuData = await fetchMenuData(fmRestaurant.reference)

  return (
    <>
      <SeoBlock
        name={minimalRestaurant.name}
        location={minimalRestaurant.address}
      />
      <RestaurantClient
        restaurant={minimalRestaurant}
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
