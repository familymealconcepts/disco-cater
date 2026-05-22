import { NextRequest, NextResponse } from 'next/server'

const FM_API = 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')
    
    console.log('Token present:', !!token)
    console.log('Token length:', token?.length)
    console.log('Token preview:', token?.slice(0, 20))

    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const res = await fetch(`${FM_API}/api/userOrder?page=0&size=50`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    })

    console.log('FM orders status:', res.status)

    if (!res.ok) {
      const errText = await res.text()
      console.log('FM orders error:', errText.slice(0, 200))
      return NextResponse.json({ error: 'Failed to fetch orders', status: res.status }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)

  } catch (err) {
    console.error('fm-orders error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
