import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/auth/reset-password  { email, temporaryPassword, newPassword }
// FM's changeTemporaryPassword endpoint authenticates with the TEMPORARY password
// as the Authorization token (per Revyrie) and takes the new password as a query
// param. The body carries the email.
export async function POST(req: NextRequest) {
  try {
    const { email, temporaryPassword, newPassword } = await req.json()
    if (!email || !temporaryPassword || !newPassword) {
      return NextResponse.json({ error: 'Email, temporary password, and new password are required.' }, { status: 400 })
    }

    const res = await fetch(`${FM}/api/changeTemporaryPassword?newPassword=${encodeURIComponent(newPassword)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: String(temporaryPassword),
      },
      body: JSON.stringify({ email }),
    })

    const text = await res.text()
    if (!res.ok) {
      let msg = 'Could not reset your password. Double-check your temporary password and try again.'
      try { const d = JSON.parse(text); msg = d.error || d.message || msg } catch { /* keep default */ }
      return NextResponse.json({ error: msg }, { status: res.status })
    }
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
