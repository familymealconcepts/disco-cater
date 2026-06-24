import { NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../../lib/fm-service-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// TEMPORARY debug probe. SUPER_ADMIN only. Hits a set of FM admin/config
// endpoints with the FM service account and returns their raw bodies so we can
// inspect what FM exposes. Remove once the config shapes are confirmed.
const ENDPOINTS = [
  `${FM}/api/admin/config`,
  `${FM}/api/admin/settings`,
  `${FM}/api/admin/integrations`,
  `${FM}/api/admin/delivery/config`,
  `${FM}/api/admin/nash/config`,
]

async function probe(url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { headers, cache: 'no-store' })
    const text = await res.text()
    // Prefer parsed JSON; fall back to the raw text when it isn't JSON.
    let body: unknown = text
    try { body = text ? JSON.parse(text) : null } catch { /* keep raw text */ }
    return { url, status: res.status, body }
  } catch (err) {
    return { url, status: 0, body: { error: err instanceof Error ? err.message : 'request failed' } }
  }
}

export async function POST() {
  // Gate: SUPER_ADMIN only.
  const role = await getAdminRole().catch(() => null)
  if (role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let headers: Record<string, string>
  try {
    headers = await getFmServiceAuthHeader()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'FM service auth failed' },
      { status: 500 },
    )
  }

  const results = await Promise.all(ENDPOINTS.map(url => probe(url, headers)))

  return NextResponse.json({
    endpoint1: results[0],
    endpoint2: results[1],
    endpoint3: results[2],
    endpoint4: results[3],
    endpoint5: results[4],
  })
}
