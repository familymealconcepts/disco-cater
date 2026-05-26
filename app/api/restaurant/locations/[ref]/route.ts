import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}`, { headers: h })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch location', raw: text }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json({ error: 'Unable to fetch location' }, { status: 500 }) }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const ct = req.headers.get('content-type') || ''
    let fd: FormData
    if (ct.startsWith('multipart/form-data')) {
      // Client already built FormData (restaurant blob + optional CSV file).
      // Forward as-is. Reconstructing FormData strips the original boundary
      // header that fetch() needs; setting Content-Type from headers handles it.
      fd = await req.formData()
    } else {
      const body = await req.json()
      fd = new FormData()
      fd.append('restaurant', new Blob([JSON.stringify(body)], { type: 'application/json' }))
    }
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}`, {
      method: 'PUT',
      headers: h,
      body: fd,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to update', raw: text }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to delete' }, { status: 500 }) }
}
