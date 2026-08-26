import { NextRequest, NextResponse } from 'next/server'
import { getAdminEmail } from '../../../../../../lib/admin-auth'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { checkConversionReadiness, convertToNative } from '../../../../../../lib/native-conversion'

// M3 — FM→Disco-native conversion tooling (super-admin).
//   GET  → readiness checklist (never mutates)
//   POST → perform the flip, ONLY when every blocking step passes (guarded by the
//          M4 marketplace-drop-off gate). Requires { confirm: true }.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// convertToNative backfills full FM order history, fetches FM's ~363-record
// system-admin list, and attempts 3 carry-over steps against FM — each its own
// FM round-trip. A single FM order-history page alone measured ~15s live; the
// full flow needs real headroom, same as sibling FM-heavy routes
// (sync/fm-orders, import-fm-menu, refresh-map-cache all declare 300).
// Missing this caused a real conversion to abort with a generic "FM orders
// fetch failed" under Vercel's default timeout, not an actual FM outage.
export const maxDuration = 300

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    return NextResponse.json(await checkConversionReadiness(ref))
  } catch (e) {
    console.error('[convert-native] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to check conversion readiness' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  let body: { confirm?: unknown }
  try { body = await req.json() } catch { body = {} }
  if (body?.confirm !== true) {
    return NextResponse.json({ error: 'Pass { confirm: true } to convert. Review the readiness checklist first.' }, { status: 400 })
  }
  // WHO ran it. Recorded on disco_conversions + disco_admin_audit — before this
  // there was no actor on a conversion anywhere, so "who made this restaurant
  // native" was unanswerable. Best-effort: a missing email must not block a
  // conversion, it just records null.
  let actorEmail: string | null = null
  try { actorEmail = await getAdminEmail() } catch { /* leave null */ }
  try {
    const result = await convertToNative(ref, { actorEmail })
    return NextResponse.json(result, { status: result.converted ? 200 : 409 })
  } catch (e) {
    console.error('[convert-native] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to convert restaurant' }, { status: 500 })
  }
}
