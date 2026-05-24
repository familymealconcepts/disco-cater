import { NextRequest, NextResponse } from 'next/server'

const FM = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  const packageRef = req.nextUrl.searchParams.get('packageRef')
  const date = req.nextUrl.searchParams.get('date')
  if (!packageRef || !date) return NextResponse.json({ error: 'packageRef and date required' }, { status: 400 })

  try {
    const res = await fetch(
      `${FM}/public-api/mealPackages/${packageRef}/availablePickUp?localDate=${date}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 300 } }
    )
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch times' }, { status: 500 })
  }
}
