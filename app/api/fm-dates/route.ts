import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  const packageRef = req.nextUrl.searchParams.get('packageRef')
  if (!packageRef) return NextResponse.json({ error: 'Missing packageRef' }, { status: 400 })
  try {
    const res = await fetch(
      `${FM}/public-api/mealPackages/${packageRef}/availableDates`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 60 } }
    )
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch dates' }, { status: 500 })
  }
}
