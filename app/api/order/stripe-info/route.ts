import { NextRequest, NextResponse } from 'next/server'

const FM = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${FM}/stripe/platform/info`, { headers })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch Stripe info' }, { status: 500 })
  }
}
