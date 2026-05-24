import { NextRequest, NextResponse } from 'next/server'

const FM = 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/public-api/delivery/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to validate address' }, { status: 500 })
  }
}
