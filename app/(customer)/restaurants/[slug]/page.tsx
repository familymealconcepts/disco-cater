import { cache } from 'react'
import type { Metadata } from 'next'
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const r = await getSanityRestaurant(slug)
  const url = `${SITE}/restaurants/${slug}`

  // Fall back to a minimal but useful set if Sanity has no doc (e.g. FM
  // fallback path) — the page itself still renders via the FM lookup.
  if (!r) {
    return {
      title: 'Catering | Disco Cater',
      description: 'Order catering on Disco Cater.',
      alternates: { canonical: url },
    }
  }

  const loc = r.location || r.address || ''
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
    alternates: { canonical: url },
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

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  // Try Sanity first (existing path — preserves cuisine tags,
  // descriptions, hero image overrides for restaurants curated there).
  const sanityRestaurant = await getSanityRestaurant(slug)

  if (sanityRestaurant) {
    const fmSlug = sanityRestaurant.orderUrl
      ? sanityRestaurant.orderUrl.replace(/.*\/disco\//, '').replace(/\/.*/, '').trim()
      : null
    const fmRef = fmSlug ? await resolveFmRef(fmSlug) : null
    const menuData = fmRef ? await fetchMenuData(fmRef) : []
    return (
      <>
        <SeoBlock
          name={sanityRestaurant.name}
          location={sanityRestaurant.location || sanityRestaurant.address}
          cuisine={sanityRestaurant.cuisines?.[0] || sanityRestaurant.cuisine}
          description={sanityRestaurant.description}
        />
        <RestaurantClient
          restaurant={sanityRestaurant}
          fmSlug={fmSlug}
          fmRef={fmRef}
          menuData={menuData}
          slug={slug}
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
      />
    </>
  )
}
