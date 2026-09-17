import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { nativeOnlyRestaurants } from '../../../../lib/admin/native-restaurant-merge'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/admin/restaurants-list — flat list for filter dropdowns (FM /api/restaurants/list)
//
// Merged with the Disco-native restaurants FamilyMeal has no record of, so a
// super admin can filter by one. Without this they were missing from every
// picker built on this endpoint while their orders still appeared in the lists
// being filtered.
export async function GET() {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/restaurants/list`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch list' }, { status: res.status })
    const data = await res.json()
    const native = (await nativeOnlyRestaurants(null, 500))
      .map(r => ({ reference: r.reference, businessName: r.businessName, native: true }))
    if (!native.length) return NextResponse.json(data)

    const byName = (a: { businessName: string }, b: { businessName: string }) => a.businessName.localeCompare(b.businessName)
    if (Array.isArray(data)) return NextResponse.json([...data, ...native].sort(byName))
    if (data && Array.isArray((data as Record<string, unknown>).content)) {
      const d = data as Record<string, unknown>
      d.content = [...(d.content as { businessName: string }[]), ...native].sort(byName)
      return NextResponse.json(d)
    }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch list' }, { status: 500 })
  }
}
