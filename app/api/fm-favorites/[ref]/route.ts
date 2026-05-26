import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Forward-compat stub. See app/api/fm-favorites/route.ts for context.
const FM_PATH = '/api/userFavorites'
const FM_LIVE = false   // flip to true once FM ships the endpoint

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!FM_LIVE) {
    return NextResponse.json(
      { error: 'FM_FAVORITES_NOT_SHIPPED', message: 'FM has no customer favorites endpoint yet — client should use local storage.' },
      { status: 501 }
    )
  }
  const { ref } = await params
  try {
    const res = await fetch(`${FM_API}${FM_PATH}/${ref}`, {
      method: 'DELETE',
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to remove favorite' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to remove favorite' }, { status: 500 })
  }
}
