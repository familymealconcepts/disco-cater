import { createClient } from '@sanity/client'
import { notFound } from 'next/navigation'
import RestaurantClient from './RestaurantClient'

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

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
}

async function resolveFmRef(slug: string): Promise<string | null> {
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
}

// FM direct slug lookup — mirrors getRestaurantByName() in
// _system/_services/restaurant/restaurant.service.ts:436-440 + the
// two-step flow used by checkout-pantry.component.ts:480-507.
// Returns the full restaurant body (with reference + address + image)
// or null if FM doesn't recognize the slug.
async function fetchFmRestaurantBySlug(slug: string): Promise<FmRestaurantLookup | null> {
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

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  // Try Sanity first (existing path — preserves cuisine tags,
  // descriptions, hero image overrides for restaurants curated there).
  const sanityRestaurant = await sanity.fetch(
    `*[_type=="restaurant" && slug.current==$slug][0]{
      name, slug, address, cuisine, cuisines, description,
      image, orderUrl, isDisco, location, tags, lat, lng
    }`,
    { slug }
  )

  if (sanityRestaurant) {
    const fmSlug = sanityRestaurant.orderUrl
      ? sanityRestaurant.orderUrl.replace(/.*\/disco\//, '').replace(/\/.*/, '').trim()
      : null
    const fmRef = fmSlug ? await resolveFmRef(fmSlug) : null
    const menuData = fmRef ? await fetchMenuData(fmRef) : []
    return (
      <RestaurantClient
        restaurant={sanityRestaurant}
        fmSlug={fmSlug}
        fmRef={fmRef}
        menuData={menuData}
        slug={slug}
      />
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

  const FM_IMG = process.env.NEXT_PUBLIC_FM_API_BASE_URL || 'https://api.familymeal.com'
  const minimalRestaurant = {
    name: fmRestaurant.businessName,
    address: joinFmAddress(fmRestaurant.address),
    cuisine: undefined,
    cuisines: [] as string[],
    description: undefined,
    image: fmRestaurant.image?.reference
      ? { asset: { url: `${FM_IMG}/public-api/images/${fmRestaurant.image.reference}/download?size=600` } }
      : undefined,
    orderUrl: `https://www.familymeal.com/${fmRestaurant.businessNameWithoutSpaces || slug}`,
    isDisco: false,
    location: undefined,
    tags: [] as string[],
  }

  const menuData = await fetchMenuData(fmRestaurant.reference)

  return (
    <RestaurantClient
      restaurant={minimalRestaurant}
      fmSlug={fmRestaurant.businessNameWithoutSpaces || slug}
      fmRef={fmRestaurant.reference}
      menuData={menuData}
      slug={slug}
    />
  )
}
