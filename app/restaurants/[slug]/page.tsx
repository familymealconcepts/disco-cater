import { createClient } from '@sanity/client'
import { notFound } from 'next/navigation'
import RestaurantClient from './RestaurantClient'

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

const FM = 'https://api.familymeal.com'

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

async function fetchMenuData(restaurantRef: string) {
  try {
    const menuRes = await fetch(
      `${FM}/public-api/menu?restaurantReference=${restaurantRef}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 300 } }
    )
    if (!menuRes.ok) return []
    const menus = await menuRes.json()
    if (!Array.isArray(menus) || !menus.length) return []

    const result = []
    for (const menu of menus) {
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

  const restaurant = await sanity.fetch(
    `*[_type=="restaurant" && slug.current==$slug][0]{
      name, slug, address, cuisine, cuisines, description,
      image, orderUrl, isDisco, location, tags, lat, lng
    }`,
    { slug }
  )

  if (!restaurant) return notFound()

  const fmSlug = restaurant.orderUrl
    ? restaurant.orderUrl.replace(/.*\/disco\//, '').replace(/\/.*/, '').trim()
    : null

  const fmRef = fmSlug ? await resolveFmRef(fmSlug) : null
  const menuData = fmRef ? await fetchMenuData(fmRef) : []

  return (
    <RestaurantClient
      restaurant={restaurant}
      fmSlug={fmSlug}
      fmRef={fmRef}
      menuData={menuData}
      slug={slug}
    />
  )
}
