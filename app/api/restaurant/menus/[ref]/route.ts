import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

async function auth() { return getRestaurantAuthHeader() }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/menu/${ref}`, { headers: h })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch menu', raw }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json({ error: 'Unable to fetch menu' }, { status: 500 }) }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/menu/${ref}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    // Read the body as text first so FM's actual error is surfaced + logged (not
    // swallowed as a bare "Failed"), and so a non-JSON FM 200 can't throw on parse.
    const text = await res.text()
    if (!res.ok) {
      console.error('[restaurant/menus PUT] FM error', res.status, text.slice(0, 800))
      return NextResponse.json({ error: 'Failed to save menu', fmStatus: res.status, raw: text.slice(0, 1000) }, { status: res.status })
    }
    let data: unknown = { ok: true }
    try { if (text) data = JSON.parse(text) } catch { data = { ok: true, raw: text.slice(0, 500) } }
    return NextResponse.json(data)
  } catch (e) {
    console.error('[restaurant/menus PUT] proxy error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/menu/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to delete' }, { status: 500 }) }
}
