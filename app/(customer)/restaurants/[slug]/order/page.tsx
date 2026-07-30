import { notFound } from 'next/navigation'
import OrderWizard from './OrderWizard'
import { getCachedRestaurant, fetchMenuData } from '../shared'

const FM_IMG = process.env.NEXT_PUBLIC_FM_API_BASE_URL || 'https://api.familymeal.com'

interface Pkg {
  reference: string
  name: string
  description?: string
  price: number
  serves?: number
  image?: string
}

// FM's /mealPackages endpoint requires a menuReference (a bare call 500s) —
// fetchMenuData already resolves the restaurant's menus (sorted so the
// admin-defined primary/position-0 menu leads) and fetches each one's
// categories correctly. This page only has a single flat package grid (no
// menu/category tabs), so it flattens the primary menu's categories, matching
// FM's own "default menu" convention already established in shared.tsx.
async function fetchPrimaryMenuPackages(restaurantRef: string): Promise<Pkg[]> {
  const menuData = await fetchMenuData(restaurantRef)
  const primary = menuData[0]
  if (!primary) return []
  const packages: Pkg[] = []
  for (const cat of primary.categories) {
    const list = Array.isArray((cat as { mealPackages?: unknown[] })?.mealPackages)
      ? (cat as { mealPackages: Record<string, unknown>[] }).mealPackages
      : []
    for (const p of list) {
      // FM's raw price is dollars (e.g. 310 for a $310 package — see
      // RestaurantClient.tsx's formatPrice, which never divides). OrderWizard's
      // own totals math (display /100, Stripe-charge fallback multiplication)
      // assumes cents throughout, so convert here rather than touch that flow.
      const dollars = typeof p.price === 'number' ? p.price : parseFloat(String(p.price)) || 0
      const price = Math.round(dollars * 100)
      const serves = typeof p.serves === 'number' ? p.serves
        : typeof p.displayServes === 'number' ? p.displayServes
        : parseFloat(String(p.serves ?? p.displayServes ?? '')) || undefined
      const imgRef = (p.image as { reference?: string } | undefined)?.reference
      packages.push({
        reference: String(p.reference), name: String(p.name ?? ''),
        description: p.description ? String(p.description) : undefined,
        price, serves,
        image: imgRef ? `${FM_IMG}/public-api/images/${imgRef}/download?size=400` : undefined,
      })
    }
  }
  return packages
}

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

  const packages = await fetchPrimaryMenuPackages(restaurantRef)

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
