import { NextRequest, NextResponse } from 'next/server'

const FM_API = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || ''
    // Strip any existing Bearer prefix then re-add cleanly
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()

    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const res = await fetch(`${FM_API}/api/userOrder?page=0&size=50`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    })

    console.log('FM orders status:', res.status)

    if (!res.ok) {
      const errText = await res.text()
      console.log('FM orders error body:', errText.slice(0, 300))
      return NextResponse.json({ error: 'Failed to fetch orders', fmStatus: res.status }, { status: res.status })
    }

    const data = await res.json()
    console.log('FM orders success, count:', JSON.stringify(data).slice(0, 100))
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-orders error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
