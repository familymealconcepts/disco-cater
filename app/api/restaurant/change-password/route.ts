import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const { oldPassword, newPassword } = await req.json()
    if (!oldPassword || !newPassword) {
      return NextResponse.json({ error: 'Missing passwords' }, { status: 400 })
    }
    const params = new URLSearchParams({ oldPassword, newPassword })
    const res = await fetch(`${FM}/api/changePassword?${params}`, {
      method: 'POST',
      headers: h,
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to change password', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to change password' }, { status: 500 })
  }
}
