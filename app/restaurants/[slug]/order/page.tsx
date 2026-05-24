import { createClient } from '@sanity/client'
import { notFound } from 'next/navigation'
import OrderWizard from './OrderWizard'

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ package?: string; orderRef?: string; date?: string; time?: string; orderType?: string }>
}) {
  const { slug } = await params
  const sp = await searchParams

  const restaurant = await client.fetch(
    `*[_type=="restaurant" && slug.current==$slug][0]{
      name, slug, address, cuisine, cuisines, description,
      image, orderUrl, isDisco, location, tags, lat, lng
    }`,
    { slug }
  )

  if (!restaurant) return notFound()

  const restaurantRef = restaurant.orderUrl
    ? restaurant.orderUrl.replace(/.*\/disco\//, '').replace(/\/.*/, '')
    : null

  if (!restaurantRef) return notFound()

  let packages: any[] = []
  try {
    const res = await fetch(
      `https://api.familymeal.com/public-api/restaurants/${restaurantRef}/mealPackages`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } }
    )
    if (res.ok) packages = await res.json()
  } catch {}

  return (
    <OrderWizard
      restaurant={restaurant}
      restaurantRef={restaurantRef}
      packages={Array.isArray(packages) ? packages : []}
      initialPackageRef={sp.package ?? null}
      initialOrderRef={sp.orderRef ?? null}
      initialDate={sp.date ?? null}
      initialTime={sp.time ?? null}
      initialOrderType={sp.orderType ?? null}
      slug={slug}
    />
  )
}
