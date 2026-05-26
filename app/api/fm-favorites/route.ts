import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../lib/auth'

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM has not shipped customer favorites endpoints yet — verified by
// grepping the entire familymeal-backend Angular source. No service,
// no model, no route. Project Orca doesn't mention favorites either.
// The two proxies (GET, POST here + DELETE in [ref]/route.ts) exist
// as forward-compatible stubs: when FM ships an endpoint we just
// swap the early-return for the real fetch() and the client hook
// automatically switches off the localStorage fallback path.

// If FM lands the feature at a path like /api/users/favorites or
// /api/userFavorites, change `FM_PATH` and remove the 501 return.
const FM_PATH = '/api/userFavorites'
const FM_LIVE = false   // flip to true once FM ships the endpoint

export async function GET(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!FM_LIVE) {
    return NextResponse.json(
      { error: 'FM_FAVORITES_NOT_SHIPPED', message: 'FM has no customer favorites endpoint yet — client should use local storage.' },
      { status: 501 }
    )
  }
  try {
    const res = await fetch(`${FM_API}${FM_PATH}`, {
      headers: { Authorization: token, Accept: 'application/json' },
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to load favorites' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to load favorites' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!FM_LIVE) {
    return NextResponse.json(
      { error: 'FM_FAVORITES_NOT_SHIPPED', message: 'FM has no customer favorites endpoint yet — client should use local storage.' },
      { status: 501 }
    )
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM_API}${FM_PATH}`, {
      method: 'POST',
      headers: { Authorization: token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to add favorite' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to add favorite' }, { status: 500 })
  }
}
