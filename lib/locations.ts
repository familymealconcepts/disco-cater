import { cache } from 'react'
import { sql } from './db'
import { getNativeLinkBySlug } from './multi-unit-links'
import { getLinkGradient, cacheAutoGradient } from './location-links'
import { stateFromAddress } from './us-states'

// Resolves a restaurant-portal "Links" shareable slug (discocater.com/locations/
// {slug}) to the underlying FM locations and their Disco ordering pages.
//
// FM endpoint: GET /public-api/restaurants/group/{slug} — PUBLIC (no auth). It
// returns the multi-unit link's restaurants grouped by state:
//   [{ state, restaurants: [{ reference, businessName, businessNameWithoutSpaces,
//      address: { addressLine1, city, state, zipcode, latitude, longitude, phoneNumber } }] }]
// 404 (RESTAURANT_GROUP_NOT_FOUND) when the slug isn't a live locations page.
// The /group endpoint carries no link title/image; the real title comes from the
// disco_location_links mirror or, failing that, FM's /links/{url} `header`.

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export interface LocationItem {
  restaurantReference: string
  businessName: string
  address: string
  /** State the FM group endpoint filed this location under — used to sort/group. */
  state: string
  /** disco_restaurant_cache.slug → /restaurants/[slug]; null when no cache row exists. */
  slug: string | null
}

export interface LocationLink {
  title: string
  image: string | null
  /**
   * Header brand gradient (CSS) to use when there is no banner `image`. Resolved
   * by precedence: manual override → cached/lazily-extracted brand gradient. null
   * when neither applies, so the page falls back to the generic Disco gradient.
   */
  gradient: string | null
  locations: LocationItem[]
}

interface FmGroupRestaurant {
  reference?: string
  businessName?: string
  businessNameWithoutSpaces?: string
  address?: { addressLine1?: string; city?: string; state?: string; zipcode?: string }
}
interface FmStateGroup { state?: string; restaurants?: FmGroupRestaurant[] }

// Humanize the slug for the page heading (FM's group endpoint returns no title).
function titleFromSlug(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, ' ').trim()
  return cleaned ? cleaned.replace(/\b\w/g, c => c.toUpperCase()) : slug
}

function formatAddress(a?: FmGroupRestaurant['address']): string {
  if (!a) return ''
  if (a.addressLine1) return a.addressLine1
  return [a.city, a.state, a.zipcode].filter(Boolean).join(', ')
}

// Resolve the uploaded Link Image (and real title) from Neon — the restaurant
// portal mirrors every link create/update into disco_location_links, so the
// public page reads it with one fast indexed query (no FM auth, no listing
// scan). Best effort: a missing table/row or any DB error returns nulls and the
// page falls back to the slug-derived title + brand hero gradient.
async function resolveLinkBanner(slug: string): Promise<{ image: string | null; header: string | null }> {
  try {
    const rows = (await sql`
      SELECT image_url, title FROM disco_location_links WHERE slug = ${slug} LIMIT 1
    `) as { image_url: string | null; title: string | null }[]
    const row = rows[0]
    if (!row) return { image: null, header: null }
    return { image: row.image_url || null, header: row.title || null }
  } catch {
    return { image: null, header: null }
  }
}

// Resolve the header brand gradient for a link (used only when it has no banner
// image). Precedence: manual override → cached auto gradient (if its source image
// is unchanged) → lazily extract from the representative restaurant's logo, then
// marketplace image, and cache the result. Returns null → generic Disco gradient.
// A negative result (no usable brand color) is cached too (empty string keyed by
// the same source) so we don't re-download + re-process the image on every view.
async function resolveGradient(slug: string, representativeRef: string | null): Promise<string | null> {
  const g = await getLinkGradient(slug)
  if (g.override) return g.override

  // Representative restaurant's image sources (both FM and native restaurants live
  // in disco_restaurant_cache, keyed by reference: icon_url = logo, image_url =
  // marketplace photo).
  let iconUrl: string | null = null
  let imageUrl: string | null = null
  if (representativeRef) {
    try {
      const rows = (await sql`
        SELECT icon_url, image_url FROM disco_restaurant_cache
        WHERE restaurant_reference = ${representativeRef} LIMIT 1
      `) as { icon_url: string | null; image_url: string | null }[]
      iconUrl = rows[0]?.icon_url || null
      imageUrl = rows[0]?.image_url || null
    } catch { /* ignore — fall through to cache/generic */ }
  }
  if (!iconUrl && !imageUrl) return g.autoGradient // nothing to derive from

  const src = `${iconUrl || ''}|${imageUrl || ''}`
  // Already computed for this exact source (including a cached negative) → trust it.
  if (g.autoSrc === src) return g.autoGradient

  const { brandGradient } = await import('./brand-color') // defer sharp load
  const res = await brandGradient({ iconUrl, imageUrl }).catch(() => null)
  const css = res ? res.css : '' // '' = negative cache (no usable brand color)
  await cacheAutoGradient(slug, css, src)
  return css || null
}

// The real link title AND banner image, both from FM's /links/{url} endpoint
// ("...with header and image" — /group/{url} carries neither). Used as a
// fallback for FM links that were never mirrored into disco_location_links, or
// were mirrored before this table tracked images/were last edited outside this
// portal's upload UI (lib/location-links.ts's upsertLocationLink deliberately
// never re-syncs image_url from FM on conflict — see its own comment — so an
// image that only ever existed in FM stays there forever unless someone
// re-uploads through the crop UI). Confirmed real for Namkeen: FM's record has
// a populated `image.reference` while disco_location_links.image_url is null.
// Image URL built the same way the admin Links list's own imageUrl() helper
// does (manage/multi-unit-links/page.tsx) — same FM image CDN pattern used for
// restaurant hero images elsewhere (size=600). Best-effort: any failure →
// nulls (the caller then falls back to the slug / gradient).
async function fetchFmLink(slug: string): Promise<{ header: string | null; imageUrl: string | null }> {
  try {
    const res = await fetch(`${FM}/public-api/restaurants/links/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) return { header: null, imageUrl: null }
    const data = (await res.json().catch(() => null)) as { header?: string; image?: { reference?: string } } | null
    const header = data?.header?.trim() || null
    const ref = data?.image?.reference
    const imageUrl = ref ? `${FM}/public-api/images/${ref}/download?size=600` : null
    return { header, imageUrl }
  } catch {
    return { header: null, imageUrl: null }
  }
}

/**
 * Look up a locations link by slug. Returns null when FM has no live locations
 * page for the slug (404) or it resolves to zero restaurants — both render the
 * "no longer active" page. `cache()` dedupes the FM + Sanity work across
 * generateMetadata + the page render within a single request.
 */
export const getLocationLink = cache(async (slug: string): Promise<LocationLink | null> => {
  // Native link? Resolve entirely from Neon (zero FM). Members → disco_restaurant_cache
  // (live only, mirroring FM's onlineOrderingAllowed filter) → grouped by state on the
  // page. Native restaurants have their own /restaurants/{slug} pages.
  const nativeLink = await getNativeLinkBySlug(slug).catch(() => null)
  if (nativeLink) {
    if (!nativeLink.memberRefs.length) return null
    const rows = (await sql`
      SELECT restaurant_reference, name, slug, address, location FROM disco_restaurant_cache
      WHERE restaurant_reference = ANY(${nativeLink.memberRefs}) AND is_live = true
    `.catch(() => [])) as { restaurant_reference: string; name: string; slug: string | null; address: string | null; location: string | null }[]
    if (!rows.length) return null
    const locations: LocationItem[] = rows.map(r => ({
      restaurantReference: r.restaurant_reference,
      businessName: r.name || 'Restaurant',
      address: r.address || r.location || '',
      state: stateFromAddress(r.address) || stateFromAddress(r.location) || '',
      slug: r.slug || null,
    }))
    const banner = await resolveLinkBanner(slug)
    const gradient = banner.image ? null : await resolveGradient(slug, nativeLink.memberRefs[0] || null)
    return { title: nativeLink.title || titleFromSlug(slug), image: banner.image, gradient, locations }
  }

  let res: Response
  try {
    res = await fetch(`${FM}/public-api/restaurants/group/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } catch {
    return null
  }
  if (!res.ok) return null // includes FM's 404 RESTAURANT_GROUP_NOT_FOUND

  const groups = (await res.json().catch(() => null)) as FmStateGroup[] | null
  if (!Array.isArray(groups)) return null

  // Keep the state each restaurant was grouped under (the group's `state`, or
  // the restaurant's own address.state as a fallback) so the page can sort by it.
  const flat: (FmGroupRestaurant & { _state?: string })[] = []
  for (const g of groups) {
    if (Array.isArray(g?.restaurants)) {
      for (const r of g.restaurants) flat.push({ ...r, _state: g.state || r.address?.state })
    }
  }
  if (flat.length === 0) return null

  // Resolve each FM restaurant's slug from disco_restaurant_cache — the SAME
  // table/column the customer-facing restaurant detail page uses (shared.tsx's
  // getCachedRestaurant/loadDiscoNativeRestaurant) — rather than Sanity. Sanity's
  // slug.current is frozen from whenever that doc was last touched and drifts
  // from the real, current slug (confirmed: 3 of 6 Namkeen locations had a wrong
  // or missing Sanity-derived slug, generating a 404ing link). Keying off the
  // same source of truth as the detail page means these two can't drift apart
  // again — if a restaurant's real slug ever changes, both pages see it at once.
  const refs = flat.map(r => r.reference).filter(Boolean) as string[]
  const cacheRows = (refs.length
    ? await sql`SELECT restaurant_reference, slug FROM disco_restaurant_cache WHERE restaurant_reference = ANY(${refs})`.catch(() => [])
    : []) as { restaurant_reference: string; slug: string | null }[]
  const slugByRef = new Map(cacheRows.map(r => [r.restaurant_reference, r.slug]))

  const locations: LocationItem[] = flat.map(r => {
    const ref = r.reference || ''
    return {
      restaurantReference: ref,
      businessName: r.businessName || 'Restaurant',
      address: formatAddress(r.address),
      state: r._state || r.address?.state || '',
      slug: (ref && slugByRef.get(ref)) || null,
    }
  })

  // Resolve the uploaded Link Image and real title for the header background.
  // Title priority: mirrored disco_location_links.title → FM's own /links/{url}
  // header → humanized slug. Image priority: mirrored disco_location_links.image_url
  // (explicit override, always wins if set) → FM's own /links/{url} image → gradient
  // (final fallback, computed below only when there's no image from either source).
  // One shared FM call covers both fallbacks — only made when the mirror is missing
  // at least one of the two, never when Neon already has everything.
  const banner = await resolveLinkBanner(slug)
  const fmLink = (!banner.header || !banner.image) ? await fetchFmLink(slug) : { header: null, imageUrl: null }
  const title = banner.header || fmLink.header || titleFromSlug(slug)
  const image = banner.image || fmLink.imageUrl
  const gradient = image ? null : await resolveGradient(slug, flat[0]?.reference || null)

  return {
    title,
    image,
    gradient,
    locations,
  }
})
