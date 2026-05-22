import { NextRequest, NextResponse } from 'next/server'

const FM_API = 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
    }

    const res = await fetch(`${FM_API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    const data = await res.json()

    if (!res.ok) {
      return NextResponse.json(
        { error: data.message || 'Invalid email or password.' },
        { status: 401 }
      )
    }

    return NextResponse.json({
      email: data.email || email,
      firstName: data.firstName || data.first_name || '',
      lastName: data.lastName || data.last_name || '',
      reference: data.reference || data.id || '',
      token: data.authorization,
      refreshToken: data.refreshToken,
      role: data.role,
    })

  } catch (err) {
    console.error('fm-auth error:', err)
    return NextResponse.json(
      { error: 'Unable to connect to FamilyMeal. Please try again.' },
      { status: 500 }
    )
  }
}
