import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

interface FmSystemAdmin {
  reference: string; firstName: string; lastName?: string; email: string
  managedRestaurants?: { reference: string; businessName?: string }[]
}

// FM's /api/admin/users/system-admin accepts NO working filter param — confirmed
// empirically (search/query/name/email/q/businessName/restaurantName/keyword/
// searchName/fullName all silently no-op; totalElements stays 363 regardless).
// This is what made the System Admins page's search look broken: the frontend
// searched only whatever 25-row page happened to be loaded, so typing "decheco"
// against a 363-admin, 15-page list found only whichever DeCheco's admin(s)
// happened to land on page 1 — which is exactly how "Nathan and Cory don't
// exist" got concluded when both were really just off-page.
//
// FM returns all 363 in a single call at size=1000 (confirmed totalPages:1), so
// the fix is to filter here, server-side, across the FULL list — not to keep
// asking FM for something it doesn't support.
const FM_FETCH_SIZE = 2000

async function fetchAllFmSystemAdmins(h: Record<string, string>): Promise<FmSystemAdmin[]> {
  const res = await fetch(`${FM}/api/admin/users/system-admin?size=${FM_FETCH_SIZE}`, { headers: h })
  if (!res.ok) throw new Error(`FM system-admin fetch failed: ${res.status}`)
  const j = await res.json()
  return (j.content || []) as FmSystemAdmin[]
}

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const search = (sp.get('search') || '').trim().toLowerCase()
  const page = Number(sp.get('page') || '0')
  const size = Number(sp.get('size') || '25')

  // No search term: cheap passthrough, same shape as before — no behavior
  // change to the common (unfiltered) load.
  if (!search) {
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(size))
    sp.getAll('sort').forEach(s => params.append('sort', s))
    try {
      const res = await fetch(`${FM}/api/admin/users/system-admin?${params}`, { headers: h })
      if (!res.ok) return NextResponse.json({ error: 'Failed to fetch system admins' }, { status: res.status })
      return NextResponse.json(await res.json())
    } catch {
      return NextResponse.json({ error: 'Unable to fetch system admins' }, { status: 500 })
    }
  }

  // Search term present: pull the full list once and filter here — name, email,
  // and restaurant name (any of managedRestaurants[].businessName), matching
  // what the search box's placeholder actually promises.
  try {
    const all = await fetchAllFmSystemAdmins(h)
    const matches = all.filter(a =>
      `${a.firstName || ''} ${a.lastName || ''}`.toLowerCase().includes(search) ||
      (a.email || '').toLowerCase().includes(search) ||
      (a.managedRestaurants || []).some(r => (r.businessName || '').toLowerCase().includes(search)),
    )
    const start = page * size
    return NextResponse.json({
      content: matches.slice(start, start + size),
      totalElements: matches.length,
      totalPages: Math.max(1, Math.ceil(matches.length / size)),
    })
  } catch {
    return NextResponse.json({ error: 'Unable to search system admins' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    body.role = 'SYSTEM_ADMIN'
    const res = await fetch(`${FM}/api/admin/users/system-admin`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to create system admin', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to create system admin' }, { status: 500 })
  }
}
