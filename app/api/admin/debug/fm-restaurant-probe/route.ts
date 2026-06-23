import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../../lib/fm-service-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// TEMPORARY debug route — DELETE after one use.
// SUPER_ADMIN-gated read-only probe of FM's restaurant endpoints (to inspect
// Stripe Connect / moneyFlow fields for a given restaurant reference).
//   POST { restaurantReference } → { endpoint1, endpoint2, endpoint3 }
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  if ((await getAdminRole()) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let ref = ''
  try {
    const body = await req.json()
    ref = String(body?.restaurantReference || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (!ref) return NextResponse.json({ error: 'restaurantReference is required.' }, { status: 400 })

  let auth: Record<string, string>
  try {
    auth = await getFmServiceAuthHeader()
  } catch (e) {
    return NextResponse.json({ error: 'FM service auth unavailable', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  // GET a URL with the service JWT; return status + parsed body (or raw text).
  async function get(url: string): Promise<{ url: string; status: number; body: unknown }> {
    try {
      const res = await fetch(url, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' })
      const text = await res.text()
      let body: unknown
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { url, status: res.status, body }
    } catch (e) {
      return { url, status: 0, body: { error: e instanceof Error ? e.message : String(e) } }
    }
  }

  const [endpoint1, endpoint2, endpoint3] = await Promise.all([
    get(`${FM}/api/admin/restaurants/${ref}`),
    get(`${FM}/api/admin/restaurants/${ref}/stripe`),
    get(`${FM}/public-api/v2/restaurants/${ref}`),
  ])

  return NextResponse.json({ restaurantReference: ref, endpoint1, endpoint2, endpoint3 })
}
