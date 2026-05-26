import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers['Authorization'] = token

    const res = await fetch(`${FM}/stripe/platform/info`, { headers })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch Stripe info' }, { status: 500 })
  }
}
