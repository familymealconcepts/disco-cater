import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('ref')
  if (!ref) return NextResponse.json([], { status: 400 })

  try {
    const res = await fetch(
      `https://api.familymeal.com/public-api/restaurants/${ref}/mealPackages`,
      { headers: { 'Accept': 'application/json' }, next: { revalidate: 3600 } }
    )
    if (!res.ok) return NextResponse.json([])
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json([])
  }
}
