import { redirect } from 'next/navigation'
import { getRestaurantRef, getRestaurantRole } from '../../../../../../../lib/restaurant-auth'
import EditOrderClient, { type MenuSection } from './EditOrderClient'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Server-side menu load — mirrors the customer builder's fetchMenuData
// (app/(customer)/restaurants/[slug]/shared.tsx): menus first, then each
// menu's categories+packages. Public endpoints (no auth needed).
async function fetchMenuData(restaurantRef: string): Promise<MenuSection[]> {
  try {
    const menuRes = await fetch(`${FM}/public-api/menu?restaurantReference=${restaurantRef}`, {
      headers: { Accept: 'application/json' }, next: { revalidate: 300 },
    })
    if (!menuRes.ok) return []
    const menus = await menuRes.json()
    if (!Array.isArray(menus) || !menus.length) return []
    const ordered = [...menus].sort((a, b) => {
      const pa = typeof a?.position === 'number' ? a.position : Number.MAX_SAFE_INTEGER
      const pb = typeof b?.position === 'number' ? b.position : Number.MAX_SAFE_INTEGER
      return pa - pb
    })
    const result: MenuSection[] = []
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

export default async function EditOrderPage({ params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params

  const role = await getRestaurantRole()
  if (!role) {
    console.error('[edit-page] no role — redirecting to login', { orderRef })
    redirect('/restaurant/login')
  }

  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) {
    console.error('[edit-page] no restaurantRef — redirecting to select-location', { orderRef, role })
    redirect('/restaurant/select-location')
  }

  console.error('[edit-page] loading', { orderRef, restaurantRef, role })

  let menuData: MenuSection[] = []
  try {
    menuData = await fetchMenuData(restaurantRef)
    console.error('[edit-page] menu loaded', { orderRef, restaurantRef, menuSections: menuData.length })
  } catch (err) {
    console.error('[edit-page] menu fetch failed', { orderRef, restaurantRef, err })
  }

  return <EditOrderClient orderRef={orderRef} restaurantRef={restaurantRef} menuData={menuData} />
}
