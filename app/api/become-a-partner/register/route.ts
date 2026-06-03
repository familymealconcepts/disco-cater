import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Restaurant-onboarding registration. Proxies to FM's public /registration
// endpoint and returns the JWT + user payload so the client can persist it as
// `currentUser` and continue the onboarding flow.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { email, firstName, lastName, password, phoneNumber } = body
    if (!email || !password || !firstName || !lastName) {
      return NextResponse.json({ error: 'First name, last name, email and password are required.' }, { status: 400 })
    }

    const fmRes = await fetch(`${FM}/registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, firstName, lastName, password, phoneNumber: phoneNumber || '' }),
    })

    const data = await fmRes.json().catch(() => null)
    if (!fmRes.ok) {
      return NextResponse.json({ error: data?.message || data?.description || 'Registration failed.' }, { status: fmRes.status })
    }

    const authorization = String(data?.authorization || '').replace(/^Bearer\s+/i, '').trim()
    return NextResponse.json({
      authorization,
      refreshToken: String(data?.refreshToken || '').trim(),
      email: data?.email || email,
      firstName: data?.firstName || firstName,
      lastName: data?.lastName || lastName,
      phoneNumber: data?.phoneNumber || phoneNumber || '',
      reference: data?.reference || '',
      role: data?.role || '',
    })
  } catch (err) {
    console.error('become-a-partner/register error:', err)
    return NextResponse.json({ error: 'Unable to connect. Please try again.' }, { status: 500 })
  }
}
