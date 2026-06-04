import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Type-ahead restaurant search for the Menu Import picker. Proxies FM's admin
// restaurant list (the same endpoint + `searchName` filter the ordering list
// uses) and returns a slim [{ reference, name, location }] shape — the UUID is
// used internally; the user only ever sees the name + location.
export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  if (q.length < 3) return NextResponse.json([])

  try {
    const params = new URLSearchParams({ searchName: q, page: '0', size: '20' })
    const res = await fetch(`${FM}/api/admin/restaurants?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json([])
    const data = await res.json().catch(() => null)
    const content: any[] = Array.isArray(data) ? data : (data?.content || data?.data || [])
    const results = content
      .map(r => ({
        reference: r?.reference || '',
        name: r?.businessName || r?.name || '',
        location: [r?.address?.city, r?.address?.state].filter(Boolean).join(', '),
      }))
      .filter(r => r.reference && r.name)
    return NextResponse.json(results)
  } catch {
    return NextResponse.json([])
  }
}
