import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  const restaurantRef = req.nextUrl.searchParams.get('restaurantRef')
  const menuRef = req.nextUrl.searchParams.get('menuRef')
  if (!restaurantRef || !menuRef) {
    return NextResponse.json({ error: 'Missing restaurantRef or menuRef' }, { status: 400 })
  }
  try {
    const res = await fetch(
      `${FM}/public-api/restaurants/${restaurantRef}/mealPackages?menuReference=${menuRef}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 300 } }
    )
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch packages' }, { status: 500 })
  }
}
