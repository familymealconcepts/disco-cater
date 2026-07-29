import { notFound } from 'next/navigation'
import OrderWizard from './OrderWizard'
import { getCachedRestaurant } from '../shared'

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ package?: string; orderRef?: string; date?: string; time?: string; orderType?: string }>
}) {
  const { slug } = await params
  const sp = await searchParams

  const restaurant = await getCachedRestaurant(slug)
  if (!restaurant) return notFound()

  // Neon's restaurant_reference IS the FM UUID directly — no derivation needed.
  const restaurantRef = restaurant.restaurantReference

  let packages: any[] = []
  try {
    const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
    const res = await fetch(
      `${FM}/public-api/restaurants/${restaurantRef}/mealPackages`,
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
