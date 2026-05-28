import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  // FM filters the ordering list by `searchName` (restaurant.service.ts:378-393,
  // getDefaultFilters().searchName), NOT `search` — forwarding `search` was a
  // no-op, so the search box did nothing.
  const searchTerm = sp.get('search') || sp.get('searchName')
  if (searchTerm) params.set('searchName', searchTerm)
  if (sp.get('restaurantStatus')) params.set('restaurantStatus', sp.get('restaurantStatus')!)
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/admin/restaurants?${params}`, { headers: h })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch restaurants', status: res.status, raw }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch restaurants' }, { status: 500 })
  }
}

// Create ordering restaurant — multipart with "restaurant" JSON blob + optional CSV "file"
export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const ct = req.headers.get('content-type') || ''
    let fd: FormData
    if (ct.startsWith('multipart/form-data')) {
      fd = await req.formData()
    } else {
      const body = await req.json()
      fd = new FormData()
      fd.append('restaurant', new Blob([JSON.stringify(body)], { type: 'application/json' }))
    }
    const res = await fetch(`${FM}/api/admin/restaurants`, { method: 'POST', headers: h, body: fd })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to create restaurant', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to create restaurant' }, { status: 500 })
  }
}
