import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('ref')
  if (!ref) return NextResponse.json({ error: 'Missing ref' }, { status: 400 })
  try {
    const res = await fetch(
      `https://api.familymeal.com/public-api/menu?restaurantReference=${ref}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 300 } }
    )
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch menu' }, { status: 500 })
  }
}
