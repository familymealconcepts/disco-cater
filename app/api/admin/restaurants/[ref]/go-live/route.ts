import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { checkNativeGoLiveReadiness, goLiveNativeRestaurant, recordGoLiveVerification } from '../../../../../../lib/native-go-live'

// Native go-live gate (super-admin). The ordered verify-before-live checklist.
//   GET                                   → readiness (all 7 gates)
//   POST { action: 'record', key, passed, detail } → record a real-action verification
//         (key: 'live-charge' | 'expedite-dispatch')
//   POST { action: 'flip' }               → flip the restaurant LIVE (only if every gate passes)
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    return NextResponse.json(await checkNativeGoLiveReadiness(ref))
  } catch (e) {
    console.error('[go-live] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to check go-live readiness' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  let body: { action?: unknown; key?: unknown; passed?: unknown; detail?: unknown }
  try { body = await req.json() } catch { body = {} }
  const action = String(body?.action || '')
  try {
    if (action === 'record') {
      const key = String(body?.key || '')
      if (key !== 'live-charge' && key !== 'expedite-dispatch') return NextResponse.json({ error: "key must be 'live-charge' or 'expedite-dispatch'" }, { status: 400 })
      await recordGoLiveVerification(ref, key, body?.passed !== false, String(body?.detail || '').slice(0, 500))
      return NextResponse.json(await checkNativeGoLiveReadiness(ref))
    }
    if (action === 'flip') {
      const result = await goLiveNativeRestaurant(ref)
      return NextResponse.json(result, { status: result.flipped ? 200 : 409 })
    }
    return NextResponse.json({ error: "Provide { action: 'record' | 'flip' }" }, { status: 400 })
  } catch (e) {
    console.error('[go-live] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Go-live action failed' }, { status: 500 })
  }
}
