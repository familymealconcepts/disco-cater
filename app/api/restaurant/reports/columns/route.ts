import { NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { REPORT_COLUMNS } from '../../../../../lib/reports/native-reports'
import { isDiscoNativeRestaurant } from '../../../../../lib/order/native-checkout'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET() {
  // Disco-native: the report column catalog (was FM → 401).
  // KEYED ON THE RESTAURANT. A native restaurant's reports are built from Disco's
  // own data, so its column catalogue must be Disco's too — on a master-password
  // FM session this used to return FamilyMeal's catalogue for a native restaurant,
  // so the columns on offer did not match the report that would be produced.
  const ctx = await getRestaurantAuthContext()
  const scopeRef = ctx ? await resolveDiscoScopeRef(ctx) : ''
  if (await isDiscoNativeRestaurant(scopeRef)) return NextResponse.json(REPORT_COLUMNS)

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/reports/columns`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch columns' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch columns' }, { status: 500 })
  }
}
