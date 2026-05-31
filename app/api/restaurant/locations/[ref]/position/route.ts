import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const position = req.nextUrl.searchParams.get('position') || '0'
  const fmUrl = `${FM}/api/system-admin/restaurants/${ref}/position?position=${position}`

  // DIAGNOSTIC LOG (Vercel server logs): the exact request we send to FM for a
  // location reorder. FM currently returns 2xx but the new position doesn't
  // persist — this captures the URL/method/payload + FM's status & body so we
  // can see what FM actually receives and says. Remove once the reorder is fixed.
  console.log('[locations/position] → FM request', JSON.stringify({
    method: 'PUT',
    url: fmUrl,
    ref,
    position,
    body: null, // we send no body — FM may instead expect { position: N } or an ordered array of refs
    authHeaderKeys: Object.keys(h), // confirm Authorization is present (not the value)
  }))

  try {
    const res = await fetch(fmUrl, { method: 'PUT', headers: h })
    const respBody = await res.text().catch(() => '')
    console.log('[locations/position] ← FM response', JSON.stringify({
      status: res.status,
      ok: res.ok,
      body: respBody.slice(0, 2000),
    }))
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[locations/position] FM fetch threw', err)
    return NextResponse.json({ error: 'Unable to update position' }, { status: 500 })
  }
}
