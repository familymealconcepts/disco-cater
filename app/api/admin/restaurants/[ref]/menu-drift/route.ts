import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { checkMenuDrift, getMenuDriftStatus, setMenuDriftBaseline } from '../../../../../../lib/menu-drift'

// Super-admin: menu-drift status for one Disco-native restaurant.
//   GET            → cheap read of the last-stored status (no FM call)
//   POST {}        → run a fresh check now (fetches FM live, updates the row)
//   POST {reset}   → re-baseline against FM's current state (e.g. after
//                    reviewing a drift and deciding to accept it as the new normal)
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const status = await getMenuDriftStatus(ref)
    return NextResponse.json(status)
  } catch (e) {
    console.error('[menu-drift] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load drift status' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  let body: { reset?: boolean } = {}
  try { body = await req.json() } catch { /* optional */ }

  try {
    if (body?.reset) {
      const result = await setMenuDriftBaseline(ref, ref)
      if (!result.ok) return NextResponse.json({ error: result.error || 'Could not re-baseline' }, { status: 502 })
      return NextResponse.json({ ok: true, itemCount: result.itemCount })
    }
    const result = await checkMenuDrift(ref, ref)
    if (!result.checked) return NextResponse.json({ error: result.error || 'Could not check FM menu' }, { status: 502 })
    return NextResponse.json(result)
  } catch (e) {
    console.error('[menu-drift] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Drift check failed' }, { status: 500 })
  }
}
