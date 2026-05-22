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

    // Fetch user profile
    const profileRes = await fetch(`${FM_API}/api/users`, {
      headers: {
        'Authorization': `Bearer ${data.authorization}`,
        'Accept': 'application/json',
      },
    })

    let firstName = ''
    let lastName = ''
    let reference = ''

    if (profileRes.ok) {
      const profile = await profileRes.json()
      console.log('FM profile:', JSON.stringify(profile).slice(0, 200))
      firstName = profile.firstName || profile.first_name || profile.name?.split(' ')[0] || ''
      lastName = profile.lastName || profile.last_name || profile.name?.split(' ')[1] || ''
      reference = profile.reference || profile.id || ''
    } else {
      console.log('Profile fetch failed:', profileRes.status)
      firstName = email.split('@')[0]
    }

    return NextResponse.json({
      email,
      firstName,
      lastName,
      reference,
      token: data.authorization,
      refreshToken: data.refreshToken,
    })

  } catch (err) {
    console.error('fm-auth error:', err)
    return NextResponse.json(
      { error: 'Unable to connect to FamilyMeal. Please try again.' },
      { status: 500 }
    )
  }
}
