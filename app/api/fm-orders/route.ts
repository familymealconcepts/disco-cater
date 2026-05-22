import { NextRequest, NextResponse } from 'next/server'

const FM_API = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()

    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Try multiple endpoint variations
    const endpoints = [
      '/api/userOrder?page=0&size=50',
      '/api/userOrder',
      '/api/v2/userOrder?page=0&size=50',
    ]

    for (const endpoint of endpoints) {
      const res = await fetch(`${FM_API}${endpoint}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      })
      console.log(`${endpoint} status:`, res.status)
      if (res.ok) {
        const data = await res.json()
        console.log('Success with endpoint:', endpoint)
        return NextResponse.json(data)
      }
    }

    return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 401 })

  } catch (err) {
    console.error('fm-orders error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
