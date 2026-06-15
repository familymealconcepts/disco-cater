import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await req.json()

    const url = `${FM_API}/api/users/addresses`
    console.log('[fm-user-addresses] PUT', url, 'fields:', Object.keys(body || {}))
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (res.status === 401) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!res.ok) {
      // Surface FM's actual error instead of swallowing it — otherwise a
      // validation failure is invisible to both the client and the logs.
      const raw = await res.text().catch(() => '')
      console.error('[fm-user-addresses] FM error:', res.status, raw.slice(0, 500))
      let parsed: { message?: string; error?: string } | null = null
      try { parsed = JSON.parse(raw) } catch { /* non-JSON body */ }
      return NextResponse.json(
        { error: parsed?.message || parsed?.error || 'Failed to update address', detail: raw.slice(0, 300) || undefined },
        { status: res.status },
      )
    }

    const data = await res.json().catch(() => ({ ok: true }))
    return NextResponse.json(data)

  } catch (err) {
    console.error('[fm-user-addresses] error:', err)
    return NextResponse.json({ error: 'Unable to update address' }, { status: 500 })
  }
}
