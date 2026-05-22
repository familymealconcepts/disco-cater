import { NextRequest, NextResponse } from 'next/server'

const FM_API = 'https://api.familymeal.com'

async function fetchWithRefresh(token: string, refreshToken: string) {
  // First attempt
  let res = await fetch(`${FM_API}/api/userOrder?page=0&size=50`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  })

  // If 401, try refreshing the token
  if (res.status === 401 && refreshToken) {
    console.log('Token expired, attempting refresh...')
    const refreshRes = await fetch(`${FM_API}/refreshToken`, {
      method: 'POST',
      headers: {
        'RefreshToken': refreshToken,
        'Accept': 'application/json',
      },
    })

    if (refreshRes.ok) {
      const refreshData = await refreshRes.json()
      const newToken = refreshData.authorization
      console.log('Token refreshed successfully')

      // Retry with new token
      res = await fetch(`${FM_API}/api/userOrder?page=0&size=50`, {
        headers: {
          'Authorization': `Bearer ${newToken}`,
          'Accept': 'application/json',
        },
      })

      return { res, newToken }
    }
  }

  return { res, newToken: null }
}

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    const refreshToken = req.headers.get('x-refresh-token') || ''

    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { res, newToken } = await fetchWithRefresh(token, refreshToken)

    console.log('FM orders final status:', res.status)

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch orders', status: res.status }, { status: res.status })
    }

    const data = await res.json()
    const response = NextResponse.json({ ...data, _newToken: newToken })
    return response

  } catch (err) {
    console.error('fm-orders error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
