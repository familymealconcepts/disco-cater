import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Create a single meal package (menu item) on a restaurant. Thin wrapper around
// FM POST /api/mealPackages with the SUPER_ADMIN admin JWT (raw, no Bearer).
//   POST /api/admin/restaurants/{ref}/menu-items
//   body: { name, price, serves, category?, description?, itemType? }
//   → { itemReference }
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let auth: Record<string, string>
  try { auth = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  const name = String(body?.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name is required.' }, { status: 400 })
  const servesNum = parseInt(String(body?.serves ?? '').replace(/[^\d]/g, ''), 10)

  try {
    const res = await fetch(`${FM}/api/mealPackages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name,
        description: String(body?.description ?? ''),
        price: Number(body?.price) || 0,
        serves: Number.isFinite(servesNum) && servesNum > 0 ? servesNum : 1,
        itemType: body?.itemType === 'REGULAR' ? 'REGULAR' : 'CATERING',
        restaurantReference: ref,
        category: body?.category ? String(body.category) : undefined,
      }),
    })
    const text = await res.text()
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to create menu item', raw: text.slice(0, 300) }, { status: res.status })
    }
    let data: Record<string, unknown> = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* non-JSON */ }
    const itemReference = String(data?.reference || data?.mealPackageReference || '')
    return NextResponse.json({ itemReference, ...data })
  } catch (e) {
    console.error('[admin/menu-items] create failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create menu item' }, { status: 500 })
  }
}
