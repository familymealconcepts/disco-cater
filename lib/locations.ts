import { cache } from 'react'
import { createClient } from '@sanity/client'

// Resolves a restaurant-portal "Links" shareable slug (discocater.com/locations/
// {slug}) to the underlying FM locations and their Disco ordering pages.
//
// FM endpoint: GET /public-api/restaurants/group/{slug} — PUBLIC (no auth). It
// returns the multi-unit link's restaurants grouped by state:
//   [{ state, restaurants: [{ reference, businessName, businessNameWithoutSpaces,
//      address: { addressLine1, city, state, zipcode, latitude, longitude, phoneNumber } }] }]
// 404 (RESTAURANT_GROUP_NOT_FOUND) when the slug isn't a live locations page.
// The endpoint carries no link title/image, so the title is derived from the slug.

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const sanity = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || '0j4eqnmw',
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  useCdn: true, // public read — no token
})

export interface LocationItem {
  restaurantReference: string
  businessName: string
  address: string
  /** State the FM group endpoint filed this location under — used to sort/group. */
  state: string
  /** Sanity slug.current → /restaurants/[slug]; null when no Sanity doc exists. */
  slug: string | null
}

export interface LocationLink {
  title: string
  image: string | null
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

// FM slug = the segment after /disco/ in a Sanity orderUrl.
function fmSlugFromOrderUrl(orderUrl?: string): string | null {
  if (!orderUrl) return null
  const m = orderUrl.match(/\/disco\/([^/?#]+)/)
  return m ? m[1].toLowerCase() : null
}

function formatAddress(a?: FmGroupRestaurant['address']): string {
  if (!a) return ''
  if (a.addressLine1) return a.addressLine1
  return [a.city, a.state, a.zipcode].filter(Boolean).join(', ')
}

/**
 * Look up a locations link by slug. Returns null when FM has no live locations
 * page for the slug (404) or it resolves to zero restaurants — both render the
 * "no longer active" page. `cache()` dedupes the FM + Sanity work across
 * generateMetadata + the page render within a single request.
 */
export const getLocationLink = cache(async (slug: string): Promise<LocationLink | null> => {
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

  // Resolve each FM restaurant to its Sanity slug. Primary key is the backfilled
  // `fmReference`; fall back to matching the FM slug against the orderUrl.
  const refs = flat.map(r => r.reference).filter(Boolean) as string[]
  const fmSlugs = flat.map(r => (r.businessNameWithoutSpaces || '').toLowerCase()).filter(Boolean)
  const patterns = fmSlugs.map(s => `*/disco/${s}*`)

  let docs: { fmReference?: string; orderUrl?: string; slug?: string }[] = []
  if (refs.length || patterns.length) {
    try {
      docs = await sanity.fetch(
        `*[_type == "restaurant" && (fmReference in $refs || orderUrl match $patterns)]{ fmReference, orderUrl, "slug": slug.current }`,
        { refs, patterns },
      )
    } catch {
      docs = []
    }
  }

  const locations: LocationItem[] = flat.map(r => {
    const ref = r.reference || ''
    const fmSlug = (r.businessNameWithoutSpaces || '').toLowerCase()
    let doc = ref ? docs.find(d => d.fmReference && d.fmReference === ref) : undefined
    if (!doc && fmSlug) doc = docs.find(d => fmSlugFromOrderUrl(d.orderUrl) === fmSlug)
    return {
      restaurantReference: ref,
      businessName: r.businessName || 'Restaurant',
      address: formatAddress(r.address),
      state: r._state || r.address?.state || '',
      slug: doc?.slug || null,
    }
  })

  return { title: titleFromSlug(slug), image: null, locations }
})
