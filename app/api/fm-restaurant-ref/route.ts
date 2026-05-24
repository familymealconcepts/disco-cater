import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug')
  if (!slug) return NextResponse.json({ error: 'Missing slug' }, { status: 400 })
  try {
    const res = await fetch('https://api.familymeal.com/public-api/restaurants', {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    })
    if (!res.ok) return NextResponse.json({ error: 'FM API error' }, { status: 502 })
    const list: { reference: string; businessName: string; businessNameWithoutSpaces: string }[] = await res.json()
    const match = list.find(r => r.businessNameWithoutSpaces === slug)
    if (!match) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    return NextResponse.json({ reference: match.reference, businessName: match.businessName })
  } catch {
    return NextResponse.json({ error: 'Failed to resolve restaurant reference' }, { status: 500 })
  }
}
