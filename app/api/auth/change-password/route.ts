import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Customer password change. Proxies FM's POST /api/changePassword
// (?oldPassword=&newPassword=) with the diner JWT.
export async function PUT(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const { currentPassword, newPassword } = await req.json()
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current and new password are required.' }, { status: 400 })
    }
    if (String(newPassword).length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters.' }, { status: 400 })
    }
    const params = new URLSearchParams({ oldPassword: currentPassword, newPassword })
    const res = await fetch(`${FM}/api/changePassword?${params}`, {
      method: 'POST',
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      let msg = 'Could not update password. Check your current password and try again.'
      try { const j = JSON.parse(raw); msg = j?.message || j?.description || msg } catch {}
      return NextResponse.json({ error: msg }, { status: res.status })
    }
    const text = await res.text()
    let data: unknown = { ok: true }
    try { if (text) data = JSON.parse(text) } catch {}
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to update password. Please try again.' }, { status: 500 })
  }
}
